// Settings → API keys: let the fleet's own systems (TMS, telematics, dispatch or autonomy
// platforms) read the network and book through the API without a person signing in.
import { useCallback, useEffect, useState } from "react";
import type { ApiKey } from "../../shared/model";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtRelative } from "../app/format";
import { Field, Icon, Modal, Seg, Spinner, copyText } from "../ui/ui";

type KeyRole = ApiKey["role"];
const ROLE_HINT: Record<KeyRole, string> = {
  planner: "Reads the network, trucks and bookings, and books, changes and cancels slots.",
  viewer: "Reads the network, trucks and bookings only.",
};
const EXPIRY = [
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

const fmtDate = (at: string) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function status(k: ApiKey, now: Date): { label: string; tone: "ok" | "muted" | "bad" } {
  if (k.revoked_at) return { label: "Revoked", tone: "muted" };
  if (k.expires_at && new Date(k.expires_at) <= now) return { label: "Expired", tone: "muted" };
  if (k.expires_at && new Date(k.expires_at).getTime() - now.getTime() < 14 * 86_400_000) return { label: "Expires soon", tone: "bad" };
  return { label: "Active", tone: "ok" };
}

export function ApiKeySettings() {
  const { api, fleetId, toast, now } = useApp();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!fleetId) return;
    setKeys(await api<ApiKey[]>("GET", `/fleets/${fleetId}/api-keys`));
  }, [api, fleetId]);
  useEffect(() => { void load().catch((e) => toast(e instanceof ApiFailure ? e.message : "Couldn't load API keys", "bad")); }, [load, toast]);

  // Two clicks instead of a browser dialog: the first arms the button, the second revokes.
  const revoke = async (k: ApiKey) => {
    if (confirming !== k.id) { setConfirming(k.id); return; }
    setConfirming(null);
    setBusy(k.id);
    try {
      await api("DELETE", `/fleets/${fleetId}/api-keys/${k.id}`);
      await load();
      toast(`${k.name} can no longer use the API`);
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't revoke the key", "bad");
    } finally {
      setBusy(null);
    }
  };

  const shown = (keys ?? []).filter((k) => !k.revoked_at);
  return (
    <section className="panel" id="s-api">
      <div className="panel-head">
        <h2>API keys</h2>
        <button className="btn sm right" onClick={() => setCreating(true)}><Icon name="plus" size="sm" />Create key</button>
      </div>
      <div className="panel-body stack gap-12">
        <p className="small muted">Let your own systems, such as a TMS, telematics, dispatch or autonomous vehicle platform, find bays and book them through the API without anyone signing in. Each key works for this fleet only.</p>
      </div>
      {keys === null ? (
        <div className="panel-body"><div className="skeleton" style={{ height: 40 }} /></div>
      ) : shown.length === 0 ? null : (
        <ul className="list">
          {shown.map((k) => {
            const s = status(k, now);
            return (
              <li key={k.id} className="member-row">
                <span className="avatar invite" aria-hidden="true"><Icon name="key" size="sm" /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 560 }}>{k.name} <span className="muted xs" style={{ fontFamily: "var(--mono)" }}>{k.key_hint}</span></div>
                  <div className="xs muted ellipsis">
                    {k.role === "planner" ? "Planner" : "Viewer"} · {k.last_used_at ? `last used ${fmtRelative(k.last_used_at, now)}` : "never used"}
                    {k.expires_at ? ` · expires ${fmtDate(k.expires_at)}` : " · doesn't expire"}
                  </div>
                </div>
                <span className={`tag ${s.tone === "ok" ? "ok" : s.tone === "bad" ? "warn" : ""}`}>{s.label}</span>
                <button className={`btn sm ${confirming === k.id ? "danger" : "ghost"}`} disabled={busy !== null} onClick={() => void revoke(k)} onBlur={() => setConfirming((c) => (c === k.id ? null : c))}>
                  {busy === k.id ? <Spinner /> : null}{confirming === k.id ? "Confirm revoke" : "Revoke"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating && <CreateKeyDialog onClose={() => setCreating(false)} onCreated={load} />}
    </section>
  );
}

function CreateKeyDialog({ onClose, onCreated }: { onClose(): void; onCreated(): Promise<void> }) {
  const { api, fleetId, toast } = useApp();
  const [name, setName] = useState("");
  const [role, setRole] = useState<KeyRole>("planner");
  const [expiry, setExpiry] = useState("365");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<(ApiKey & { key: string }) | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const k = await api<ApiKey & { key: string }>("POST", `/fleets/${fleetId}/api-keys`, {
        name: name.trim(), role, expires_in_days: expiry === "never" ? null : Number(expiry),
      });
      setCreated(k);
      await onCreated();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't create the key");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={created ? "Copy your API key" : "Create an API key"}
      onClose={onClose}
      foot={created
        ? <button className="btn primary" onClick={onClose}>I've stored it safely</button>
        : <><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !name.trim()} onClick={create}>{busy && <Spinner />}Create key</button></>}
    >
      {created ? (
        <div className="stack gap-12">
          <p className="small"><b>This is the only time the key is shown.</b> Put it straight into your system's secret settings or a password manager. Anyone with it can act as {created.role === "planner" ? "a planner" : "a viewer"} for this fleet.</p>
          <div className="row gap-8">
            <input className="input" readOnly value={created.key} onFocus={(e) => e.currentTarget.select()} aria-label="API key" style={{ fontFamily: "var(--mono)", fontSize: 12 }} />
            <button className="btn" onClick={() => void copyText(created.key).then((ok) => toast(ok ? "API key copied" : "Couldn't copy the key", ok ? "info" : "bad"))}><Icon name="copy" size="sm" />Copy</button>
          </div>
          <p className="xs muted">Send it in an <code>Authorization: Bearer …</code> header. The API guide in the project's docs (docs/api.md) shows how to find a bay and book it.</p>
        </div>
      ) : (
        <div className="stack gap-16">
          <Field label="Name" hint="The system that will use it, so you can tell keys apart later.">
            {(id) => <input id={id} className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="e.g. Dispatch TMS" autoFocus />}
          </Field>
          <div className="field">
            <span className="label">Access</span>
            <Seg<KeyRole> label="Access" full value={role} onChange={setRole} options={[{ value: "planner", label: "Book and read" }, { value: "viewer", label: "Read only" }]} />
            <span className="hint">{ROLE_HINT[role]}</span>
          </div>
          <div className="field">
            <span className="label">Expires</span>
            <Seg<string> label="Expires" full value={expiry} onChange={setExpiry} options={EXPIRY} />
            <span className="hint">Shorter is safer. You can revoke a key at any time.</span>
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
