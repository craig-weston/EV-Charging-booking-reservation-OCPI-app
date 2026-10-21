// Settings → Team (members, roles, invite links) and the page an invite link opens.
import { useCallback, useEffect, useState } from "react";
import type { FleetInvite, InvitePreview, Member, MemberRole, TeamView } from "../../shared/model";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { navigate } from "../app/router";
import { Avatar, BrandMark, Field, Icon, Modal, Seg, Spinner, copyText } from "../ui/ui";

export const ROLE_LABEL: Record<MemberRole, string> = { owner: "Owner", planner: "Planner", viewer: "Viewer" };
export const ROLE_HINT: Record<MemberRole, string> = {
  owner: "Books slots, manages trucks and drivers, fleet settings and the team.",
  planner: "Books slots and manages trucks and drivers.",
  viewer: "Sees bookings and trucks but can't book or change anything.",
};

export function inviteUrl(token: string) {
  return `${window.location.origin}${window.location.pathname}#/join/${token}`;
}

function daysLeft(iso: string, now: Date) {
  const d = Math.round((new Date(iso).getTime() - now.getTime()) / 86_400_000);
  return d <= 1 ? "Expires within a day" : `Expires in ${d} days`;
}

export function TeamSettings({ canManage }: { canManage: boolean }) {
  const { api, fleetId, fleet, me, toast, refreshMe, now } = useApp();
  const [team, setTeam] = useState<TeamView | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!fleetId) return;
    setTeam(await api<TeamView>("GET", `/fleets/${fleetId}/team`));
  }, [api, fleetId]);
  useEffect(() => { void load().catch((e) => toast(e instanceof ApiFailure ? e.message : "Couldn't load the team", "bad")); }, [load, toast]);

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      await load();
      toast(done);
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "That didn't work", "bad");
    } finally {
      setBusy(null);
    }
  };

  const setRole = (m: Member, role: MemberRole) => run(`role:${m.user_id}`, () => api("PATCH", `/fleets/${fleetId}/members/${m.user_id}`, { role }), `${m.email ?? "Member"} is now ${ROLE_LABEL[role].toLowerCase()}`);
  // Two clicks instead of a browser dialog: the first arms the button, the second removes.
  const remove = (m: Member) => {
    const self = m.user_id === me?.user.id;
    if (confirming !== m.user_id) { setConfirming(m.user_id); return; }
    setConfirming(null);
    void run(`rm:${m.user_id}`, async () => {
      await api("DELETE", `/fleets/${fleetId}/members/${m.user_id}`);
      if (self) { await refreshMe(); navigate("/"); }
    }, self ? "You left the fleet" : "Removed from the team");
  };

  return (
    <section className="panel" id="s-team">
      <div className="panel-head">
        <h2>Team</h2>
        {canManage && <button className="btn sm right" onClick={() => setInviting(true)}><Icon name="plus" size="sm" />Invite a colleague</button>}
      </div>
      {!team ? (
        <div className="panel-body"><div className="skeleton" style={{ height: 40 }} /></div>
      ) : (
        <ul className="list">
          {team.members.map((m) => {
            const self = m.user_id === me?.user.id;
            return (
              <li key={m.user_id} className="member-row">
                <Avatar name={m.email ?? "?"} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 560 }}>{m.email ?? "Unknown email"}{self && <span className="muted" style={{ fontWeight: 400 }}> (you)</span>}</div>
                  <div className="xs muted ellipsis">{ROLE_HINT[m.role]}</div>
                </div>
                {canManage ? (
                  <select className="select" style={{ width: 120, height: 32 }} aria-label={`Role for ${m.email ?? "member"}`} value={m.role} disabled={busy !== null} onChange={(e) => void setRole(m, e.target.value as MemberRole)}>
                    {(["owner", "planner", "viewer"] as MemberRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                ) : <span className="tag">{ROLE_LABEL[m.role]}</span>}
                {(canManage || self) && team.members.length > 1 && (
                  <button className={`btn sm ${confirming === m.user_id ? "danger" : "ghost"}`} disabled={busy !== null} onClick={() => remove(m)} onBlur={() => setConfirming((c) => (c === m.user_id ? null : c))}>
                    {busy === `rm:${m.user_id}` ? <Spinner /> : null}
                    {confirming === m.user_id ? (self ? `Leave ${fleet?.name ?? "fleet"}` : "Confirm remove") : self ? "Leave" : "Remove"}
                  </button>
                )}
              </li>
            );
          })}
          {team.invites.map((i) => (
            <li key={i.id} className="member-row pending">
              <span className="avatar invite" aria-hidden="true"><Icon name="link" size="sm" /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 560 }}>{i.email ?? "Invite link"}</div>
                <div className="xs muted ellipsis">{ROLE_LABEL[i.role]}, {daysLeft(i.expires_at, now).toLowerCase()}</div>
              </div>
              <button className="btn sm" onClick={() => void copyText(inviteUrl(i.token)).then((ok) => toast(ok ? "Invite link copied" : "Couldn't copy the link", ok ? "info" : "bad"))}><Icon name="copy" size="sm" />Copy link</button>
              <button className="btn sm ghost" disabled={busy !== null} onClick={() => void run(`inv:${i.id}`, () => api("DELETE", `/fleets/${fleetId}/invites/${i.id}`), "Invite cancelled")}>Cancel</button>
            </li>
          ))}
        </ul>
      )}
      {canManage && team && team.members.length === 1 && team.invites.length === 0 && (
        <div className="panel-body" style={{ paddingTop: 0 }}>
          <p className="small muted">Invite the people who plan charging with you. Each invite is a link that works once and expires after 7 days.</p>
        </div>
      )}
      {inviting && <InviteDialog onClose={() => setInviting(false)} onCreated={load} />}
    </section>
  );
}

function InviteDialog({ onClose, onCreated }: { onClose(): void; onCreated(): Promise<void> }) {
  const { api, fleetId, fleet, brand, toast } = useApp();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("planner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<FleetInvite | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const inv = await api<FleetInvite>("POST", `/fleets/${fleetId}/invites`, { email: email.trim() || null, role });
      setInvite(inv);
      await onCreated();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't create the invite");
    } finally {
      setBusy(false);
    }
  };

  const url = invite ? inviteUrl(invite.token) : "";
  const mail = invite
    ? `mailto:${encodeURIComponent(invite.email ?? "")}?subject=${encodeURIComponent(`Join ${fleet?.name ?? "our fleet"} on ${brand.name}`)}&body=${encodeURIComponent(`You're invited to plan truck charging with ${fleet?.name ?? "us"} on ${brand.name}.\n\nOpen this link to join (it works once and expires in 7 days):\n${url}\n`)}`
    : "";

  return (
    <Modal
      title={invite ? "Invite ready" : "Invite a colleague"}
      onClose={onClose}
      foot={invite
        ? <button className="btn primary" onClick={onClose}>Done</button>
        : <><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={create}>{busy && <Spinner />}Create invite link</button></>}
    >
      {invite ? (
        <div className="stack gap-12">
          <p className="small">Send this link to {invite.email ?? "your colleague"}. They sign in or create an account, then join as {ROLE_LABEL[invite.role].toLowerCase()}.</p>
          <div className="row gap-8">
            <input className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" style={{ fontFamily: "var(--mono)", fontSize: 12 }} />
            <button className="btn" onClick={() => void copyText(url).then((ok) => toast(ok ? "Invite link copied" : "Couldn't copy the link", ok ? "info" : "bad"))}><Icon name="copy" size="sm" />Copy</button>
          </div>
          <a className="btn ghost sm" style={{ alignSelf: "flex-start" }} href={mail}><Icon name="message" size="sm" />Send by email</a>
        </div>
      ) : (
        <div className="stack gap-16">
          <Field label="Their email" hint="Optional. Helps you see who each link is for.">
            {(id) => <input id={id} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" autoFocus />}
          </Field>
          <div className="field">
            <span className="label">Role</span>
            <Seg<MemberRole> label="Role" full value={role} onChange={setRole} options={[{ value: "planner", label: "Planner" }, { value: "viewer", label: "Viewer" }, { value: "owner", label: "Owner" }]} />
            <span className="hint">{ROLE_HINT[role]}</span>
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  );
}

/** Opened from an invite link, signed in. */
export function JoinPage({ token }: { token: string }) {
  const { api, brand, refreshMe, setFleetId, me } = useApp();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InvitePreview>("GET", `/invites/${encodeURIComponent(token)}`)
      .then(setPreview)
      .catch((e) => setError(e instanceof ApiFailure ? e.message : "Couldn't open this invite"));
  }, [api, token]);

  const join = async () => {
    setBusy(true);
    try {
      const r = await api<{ fleet_id: string }>("POST", `/invites/${encodeURIComponent(token)}/accept`);
      await refreshMe();
      setFleetId(r.fleet_id);
      navigate("/");
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't join the fleet");
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <BrandMark brand={brand} />
        {error ? (
          <>
            <div>
              <h1 style={{ fontSize: "var(--fs-xl)" }}>This invite can't be used</h1>
              <p className="small muted" style={{ marginTop: 4 }}>{error}</p>
            </div>
            <button className="btn primary lg block" onClick={() => navigate("/")}>Continue to {brand.name}</button>
          </>
        ) : !preview ? (
          <div className="empty"><Spinner label="Opening invite" /></div>
        ) : preview.already_member ? (
          <>
            <div>
              <h1 style={{ fontSize: "var(--fs-xl)" }}>You're already on {preview.fleet_name}</h1>
              <p className="small muted" style={{ marginTop: 4 }}>Signed in as {me?.user.email}. The invite is still unused, so it can go to someone else.</p>
            </div>
            <button className="btn primary lg block" onClick={() => navigate("/")}>Open {preview.fleet_name}</button>
          </>
        ) : (
          <>
            <div>
              <h1 style={{ fontSize: "var(--fs-xl)" }}>Join {preview.fleet_name}</h1>
              <p className="small muted" style={{ marginTop: 4 }}>You're invited as {ROLE_LABEL[preview.role].toLowerCase()}. {ROLE_HINT[preview.role]}</p>
            </div>
            <p className="xs muted">Signed in as {me?.user.email}{preview.email && me?.user.email && preview.email !== me.user.email.toLowerCase() ? `. The invite was sent to ${preview.email}` : ""}.</p>
            <button className="btn primary lg block" disabled={busy} onClick={join}>{busy && <Spinner />}Join fleet</button>
            <button className="btn ghost" onClick={() => navigate("/")}>Not now</button>
          </>
        )}
      </div>
    </div>
  );
}
