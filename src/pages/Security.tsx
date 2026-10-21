// Two-step verification (authenticator app), the fleet's security policy, the activity log and
// the data rights tools (export, delete fleet, delete account).
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry } from "../../shared/model";
import type { AuthClient, Factor, TotpEnrolment } from "../app/auth";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtDateTime } from "../app/format";
import { href } from "../app/router";
import { saveFile } from "../app/download";
import { BrandMark, Empty, Field, Icon, Modal, Spinner, Switch } from "../ui/ui";

const ACTION_LABEL: Record<string, string> = {
  "fleet.create": "Created the fleet and accepted the terms",
  "fleet.update": "Changed fleet settings",
  "fleet.mfa_required": "Required two-step verification for the team",
  "fleet.mfa_optional": "Made two-step verification optional",
  "fleet.terms_accepted": "Accepted updated terms",
  "fleet.export": "Exported the fleet's data",
  "fleet.delete": "Deleted a fleet",
  "invite.create": "Created an invite",
  "invite.revoke": "Cancelled an invite",
  "invite.accept": "Joined via an invite",
  "member.role": "Changed a role",
  "member.remove": "Removed someone from the team",
  "member.leave": "Left the team",
  "vehicle.delete": "Deleted a vehicle",
  "driver.delete": "Deleted a driver",
  "booking.pass_reset": "Reset a driver pass link",
  "account.delete": "Deleted their account",
  "partner.invite": "Invited an operator",
  "partner.connect": "Connected an operator",
  "partner.disconnect": "Disconnected an operator",
  "partner.token_regenerate": "Issued a new registration token",
  "brand.update": "Changed the branding",
  "legal.update": "Changed company and legal details",
  "certifications.update": "Updated certificates",
  "compliance.tick": "Ticked a compliance item",
  "compliance.untick": "Unticked a compliance item",
  "simulator.connect": "Connected the test simulator",
};

/** Six-digit code input that suits phones (numeric keyboard, one-time-code autofill). */
function CodeInput({ id, value, onChange, autoFocus }: { id: string; value: string; onChange(v: string): void; autoFocus?: boolean }) {
  return (
    <input
      id={id} className="input code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} autoFocus={autoFocus}
      value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="······"
    />
  );
}

/** Adds an authenticator app: QR code (or secret to type), then a code to prove it works. */
export function MfaEnrol({ auth, label, onDone, onCancel }: { auth: AuthClient; label: string; onDone(): void; onCancel?(): void }) {
  const [enrolment, setEnrolment] = useState<TotpEnrolment | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  useEffect(() => {
    let live = true;
    auth.enrollTotp(label).then((e) => live && setEnrolment(e)).catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't start set-up"));
    return () => { live = false; };
  }, [auth, label]);
  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrolment || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await auth.verifyTotp(enrolment.id, code);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work");
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack gap-16" onSubmit={verify}>
      <ol className="mfa-steps">
        <li>Open an authenticator app on your phone (for example Microsoft Authenticator, Google Authenticator or 1Password).</li>
        <li>Scan this code, or type the key into the app.</li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="mfa-qr">
        {enrolment ? <img src={enrolment.qr_code} alt="QR code for your authenticator app" width={176} height={176} /> : error ? null : <Spinner label="Preparing" />}
      </div>
      {enrolment && (
        <div className="small" style={{ textAlign: "center" }}>
          {showSecret ? <code className="mfa-secret">{enrolment.secret.replace(/(.{4})/g, "$1 ").trim()}</code> : <button type="button" className="btn ghost sm" onClick={() => setShowSecret(true)}>Can't scan? Show the key</button>}
        </div>
      )}
      <Field label="Code from the app">{(id) => <CodeInput id={id} value={code} onChange={setCode} />}</Field>
      {error && <div className="error-text" role="alert">{error}</div>}
      <div className="row gap-8">
        <button className="btn primary" disabled={busy || !enrolment || code.length !== 6}>{busy && <Spinner />}Turn on two-step verification</button>
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

/** Step-up after a password or email link: the account has an authenticator, so ask for its code. */
export function MfaChallenge({ auth, email, onDone }: { auth: AuthClient; email: string | null; onDone(): void }) {
  const { brand } = useApp();
  const [factor, setFactor] = useState<Factor | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    auth.factors().then((f) => setFactor(f.find((x) => x.status === "verified") ?? null)).catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your sign-in settings"));
  }, [auth]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!factor || code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await auth.verifyTotp(factor.id, code);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work");
      setCode("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <BrandMark brand={brand} />
        <div>
          <h1 style={{ fontSize: "var(--fs-xl)" }}>Two-step verification</h1>
          <p className="small muted" style={{ marginTop: 4 }}>Enter the 6-digit code from your authenticator app{email ? ` for ${email}` : ""}.</p>
        </div>
        <Field label="Code">{(id) => <CodeInput id={id} value={code} onChange={setCode} autoFocus />}</Field>
        {error && <div className="error-text" role="alert">{error}</div>}
        <button className="btn primary lg block" disabled={busy || !factor || code.length !== 6}>{busy && <Spinner />}Continue</button>
        <button type="button" className="btn ghost" onClick={() => auth.signOut()}>Use a different account</button>
        <p className="xs muted">Lost your phone? Contact your platform administrator. Once they've confirmed it's really you, they can reset two-step verification so you can set it up again.</p>
      </form>
    </div>
  );
}

/** Shown when the fleet requires two-step verification and this account hasn't set it up. */
export function MfaRequired({ fleetName, onDone }: { fleetName: string; onDone(): void }) {
  const { backend, brand, me } = useApp();
  return (
    <div className="auth-wrap">
      <div className="auth-card" style={{ width: "min(460px, 100%)" }}>
        <BrandMark brand={brand} />
        <div>
          <h1 style={{ fontSize: "var(--fs-xl)" }}>Set up two-step verification</h1>
          <p className="small muted" style={{ marginTop: 4 }}>{fleetName} requires a code from an authenticator app each time you sign in. It takes a minute.</p>
        </div>
        {backend.auth ? <MfaEnrol auth={backend.auth} label={`${brand.name} (${me?.user.email ?? "account"})`} onDone={onDone} /> : <p className="small">Not available in demo mode.</p>}
        {backend.auth && <button type="button" className="btn ghost" onClick={() => backend.auth!.signOut()}>Sign out</button>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Settings → Security

export function SecuritySettings() {
  const { backend, me, fleet, fleetId, api, refreshMe, refreshFleet, toast, brand } = useApp();
  const role = me?.memberships.find((m) => m.fleet_id === fleetId)?.role;
  const owner = role === "owner";
  const auth = backend.auth;
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"fleet" | "account" | null>(null);

  const loadFactors = useCallback(async () => {
    if (!auth) return;
    setFactors(await auth.factors().catch(() => []));
  }, [auth]);
  useEffect(() => { void loadFactors(); }, [loadFactors]);

  const verified = factors?.find((f) => f.status === "verified") ?? null;
  const aal2 = me?.mfa?.aal === "aal2";

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toast(e instanceof ApiFailure || e instanceof Error ? e.message : "That didn't work", "bad");
    } finally {
      setBusy(null);
    }
  };

  const exportData = () => run("export", async () => {
    const data = await api<unknown>("GET", `/fleets/${fleetId}/export`);
    const name = `${(fleet?.name ?? "fleet").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-export-${new Date().toISOString().slice(0, 10)}.json`;
    const outcome = await saveFile(name, JSON.stringify(data, null, 2));
    toast(outcome === "saved" ? "Export downloaded" : "Export not saved");
  });

  return (
    <section className="panel" id="s-security">
      <div className="panel-head"><h2>Security</h2></div>
      <div className="panel-body stack gap-20">
        <div className="sec-row">
          <div className="grow">
            <div className="sec-title"><Icon name="smartphone" size="sm" />Two-step verification</div>
            {!auth ? (
              <p className="small muted">In demo mode there's no real sign-in. With Supabase Auth, each person adds an authenticator app here and enters a code when they sign in.</p>
            ) : verified ? (
              <p className="small muted">On, with an authenticator app (added {fmtDateTime(verified.created_at)}). You'll be asked for a code when you sign in.</p>
            ) : (
              <p className="small muted">Add an authenticator app so a stolen password isn't enough to get into your account. Cyber Essentials expects it for every cloud service.</p>
            )}
          </div>
          {auth && factors && (verified ? (
            <button className={`btn sm ${confirmOff ? "danger" : ""}`} disabled={busy !== null || !aal2} title={!aal2 ? "Sign in with your code first" : undefined}
              onClick={() => confirmOff ? void run("off", async () => { await auth.unenroll(verified.id); await loadFactors(); await refreshMe(); setConfirmOff(false); }, "Two-step verification turned off") : setConfirmOff(true)}
              onBlur={() => setConfirmOff(false)}>
              {busy === "off" && <Spinner />}{confirmOff ? "Confirm turn off" : "Turn off"}
            </button>
          ) : <button className="btn sm primary" onClick={() => setEnrolling(true)}>Set up</button>)}
        </div>

        {fleet && owner && (
          <div className="sec-row">
            <div className="grow">
              <Switch checked={fleet.require_mfa} onChange={(v) => void run("policy", async () => { await api("PATCH", `/fleets/${fleetId}`, { require_mfa: v }); await Promise.all([refreshFleet(), refreshMe()]); }, v ? "Two-step verification is now required" : "Two-step verification is optional")}>
                <span>Require two-step verification for everyone in {fleet.name}</span>
                <span className="hint" style={{ display: "block" }}>People without it are asked to set it up before they can see the fleet. {!aal2 && !fleet.require_mfa ? "Set it up for yourself first." : ""}</span>
              </Switch>
            </div>
          </div>
        )}

        {auth && (
          <div className="sec-row">
            <div className="grow">
              <div className="sec-title"><Icon name="logOut" size="sm" />Sign out everywhere</div>
              <p className="small muted">Ends your sessions on every device, for example after losing a laptop or phone.</p>
            </div>
            <button className="btn sm" disabled={busy !== null} onClick={() => void run("all", () => auth.signOutEverywhere())}>Sign out everywhere</button>
          </div>
        )}

        {fleet && owner && <ActivityLog />}

        {me?.is_admin && (
          <div className="sec-row">
            <div className="grow">
              <div className="sec-title"><Icon name="shieldCheck" size="sm" />Platform security and compliance</div>
              <p className="small muted">Cyber Essentials readiness checklist, company details for the legal pages, certificates and account recovery.</p>
            </div>
            <a className="btn sm" href={href("/compliance")}>Open</a>
          </div>
        )}

        <div className="sec-row">
          <div className="grow">
            <div className="sec-title"><Icon name="download" size="sm" />Your data</div>
            <p className="small muted">{owner ? `Download everything held for ${fleet?.name ?? "the fleet"} as JSON (the right to data portability), or delete it.` : "Fleet owners can export or delete the fleet's data. You can delete your own account."}</p>
            <div className="row gap-8 wrap" style={{ marginTop: 10 }}>
              {owner && <button className="btn sm" disabled={busy !== null} onClick={exportData}>{busy === "export" ? <Spinner /> : <Icon name="download" size="sm" />}Export fleet data</button>}
              {owner && <button className="btn sm ghost danger-text" onClick={() => setDialog("fleet")}>Delete fleet</button>}
              <button className="btn sm ghost danger-text" onClick={() => setDialog("account")} disabled={!auth} title={!auth ? "Not available in demo mode" : undefined}>Delete my account</button>
            </div>
          </div>
        </div>
      </div>

      {enrolling && auth && (
        <Modal title="Set up two-step verification" onClose={() => setEnrolling(false)}>
          <MfaEnrol auth={auth} label={`${brand.name} (${me?.user.email ?? "account"})`} onCancel={() => setEnrolling(false)} onDone={() => { setEnrolling(false); void loadFactors(); void refreshMe(); toast("Two-step verification is on"); }} />
        </Modal>
      )}
      {dialog && <DeleteDialog kind={dialog} onClose={() => setDialog(null)} />}
    </section>
  );
}

function ActivityLog() {
  const { api, fleetId, now } = useApp();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    void api<AuditEntry[]>("GET", `/fleets/${fleetId}/audit?limit=100`).then(setRows).catch(() => setRows([]));
  }, [api, fleetId, open]);
  return (
    <div className="sec-row column">
      <button type="button" className="sec-title as-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="history" size="sm" />Activity log <Icon name={open ? "chevronDown" : "chevronRight"} size="sm" />
      </button>
      <p className="small muted">Who changed roles, invited people, exported data or changed security settings. Kept for 12 months.</p>
      {open && (!rows ? <div className="skeleton" style={{ height: 48 }} /> : rows.length === 0 ? <Empty title="Nothing yet" /> : (
        <ul className="list audit-list">
          {rows.map((e) => (
            <li key={e.id}>
              <span className="xs muted num nowrap">{fmtDateTime(e.at, now)}</span>
              <span className="grow small"><b>{e.actor_email ?? "Deleted account"}</b> {(ACTION_LABEL[e.action] ?? e.action).replace(/^./, (c) => c.toLowerCase())}{e.target ? `: ${e.target}` : ""}{e.action === "member.role" && e.data ? ` (${String(e.data.from)} → ${String(e.data.to)})` : ""}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

function DeleteDialog({ kind, onClose }: { kind: "fleet" | "account"; onClose(): void }) {
  const { api, fleet, fleetId, me, backend, refreshMe, toast } = useApp();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expected = kind === "fleet" ? fleet?.name ?? "" : me?.user.email ?? "";
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (kind === "fleet") {
        await api("DELETE", `/fleets/${fleetId}`, { confirm: typed });
        toast(`${expected} was deleted`);
        onClose();
        await refreshMe();
      } else {
        await api("DELETE", "/me", { confirm: typed });
        await backend.auth?.signOut();
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "That didn't work");
      setBusy(false);
    }
  };
  return (
    <Modal title={kind === "fleet" ? `Delete ${expected}?` : "Delete your account?"} onClose={onClose}
      foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn danger" disabled={busy || typed.trim().toLowerCase() !== expected.toLowerCase()} onClick={go}>{busy && <Spinner />}{kind === "fleet" ? "Delete fleet" : "Delete account"}</button></>}>
      <div className="stack gap-12">
        {kind === "fleet" ? (
          <p className="small">This permanently deletes the fleet's team, invites, vehicles, drivers, bookings and charge history. Download an export first if you need a copy. Upcoming bookings must be cancelled first so operators can release the bays.</p>
        ) : (
          <p className="small">This deletes your sign-in and removes you from every fleet. Fleets you own must have another owner, or be deleted first. Activity you performed stays in fleets' audit logs without your email address.</p>
        )}
        <Field label={kind === "fleet" ? `Type the fleet's name (${expected}) to confirm` : `Type your email (${expected}) to confirm`}>{(id) => <input id={id} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}
