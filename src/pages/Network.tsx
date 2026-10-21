import { useCallback, useEffect, useState } from "react";
import type { OcpiLogEntry, Partner } from "../../shared/model";

/** Partners as the admin API returns them: token material stays on the server. */
type AdminPartner = Omit<Partner, "our_token_hash" | "registration_token_hash" | "their_token"> & {
  has_their_token: boolean;
  awaiting_registration: boolean;
  /** Only present right after an invite or a new token: shown once. */
  registration_token?: string;
};
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtDateTime, fmtRelative, fmtTime } from "../app/format";
import { Empty, Field, Icon, Json, Modal, Seg, Spinner, copyText } from "../ui/ui";
import { EmptyBayArt } from "../components/art/Mini";

interface SimStatus { registered: boolean; bookings: number; active_sessions: number; sites: number }

export function NetworkPage() {
  const { api, config, toast, refreshNetwork, network, me } = useApp();
  const [partners, setPartners] = useState<AdminPartner[] | null>(null);
  const [issued, setIssued] = useState<AdminPartner | null>(null);
  const [sim, setSim] = useState<SimStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"connect" | "invite" | null>(null);

  const load = useCallback(async () => {
    setPartners(await api<AdminPartner[]>("GET", "/admin/partners"));
    if (config.simulator) setSim(await api<SimStatus>("GET", "/admin/simulator").catch(() => null));
  }, [api, config.simulator]);
  useEffect(() => { if (me?.is_admin) void load().catch((e) => toast(e.message, "bad")); }, [load, me?.is_admin, toast]);

  if (!me?.is_admin) {
    return <div className="page"><div className="panel"><Empty icon="shield" title="Platform admins only">Ask whoever runs this platform to add your account to platform_admins.</Empty></div></div>;
  }

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast(done);
      await load();
      await refreshNetwork();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "That didn't work", "bad");
    } finally {
      setBusy(null);
    }
  };

  const connected = (partners ?? []).filter((p) => p.status !== "REMOVED");
  const simPartner = connected.find((p) => p.is_simulator);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Network</h1>
          <div className="sub">Charge point operators connected over OCPI 2.3.0 with the Bookings module.</div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => setDialog("invite")}>Invite an operator</button>
          <button className="btn primary" onClick={() => setDialog("connect")}><Icon name="link" size="sm" />Connect an operator</button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Connections</h2><span className="right xs muted">{network ? `${network.locations.length} sites, ${network.booking_locations.length} bookable bay types` : ""}</span></div>
        {!partners ? <div className="empty"><Spinner /></div> : connected.length === 0 ? (
          <Empty art={<EmptyBayArt label="" />} title="No operators connected">Connect an operator with their OCPI versions URL and token, or invite them with a registration token.{config.simulator ? " Or start with the simulator below." : ""}</Empty>
        ) : (
          <ul className="list">
            {connected.map((p) => (
              <li key={p.id} className="row gap-12 wrap" style={{ padding: "14px 16px" }}>
                <span className={`status ${p.status === "CONNECTED" ? "ok" : "pending"}`}>{p.status === "CONNECTED" ? "Connected" : "Waiting"}</span>
                <div className="grow" style={{ minWidth: 220 }}>
                  <div style={{ fontWeight: 600 }}>{p.name}{p.is_simulator && <span className="tag" style={{ marginLeft: 8 }}>Simulator</span>}</div>
                  <div className="xs muted">
                    {p.roles.length ? p.roles.map((r) => `${r.business_details?.name ?? ""} (${r.country_code}*${r.party_id})`).join(", ") : "No roles yet"}
                    {p.version ? `. OCPI ${p.version}` : ""}{p.last_sync_at ? `. Synced ${fmtRelative(p.last_sync_at)}` : ""}
                  </div>
                  {p.status === "PENDING" && p.awaiting_registration && (
                    <div className="xs muted" style={{ marginTop: 6 }}>
                      Waiting for them to register with token <code>{p.token_hint ?? "…"}</code>. Tokens are shown once; issue a new one if it was lost.
                    </div>
                  )}
                </div>
                {p.status === "CONNECTED" && <button className="btn sm" disabled={!!busy} onClick={() => act(`sync-${p.id}`, () => api("POST", `/admin/partners/${p.id}/sync`), "Sites and calendars refreshed")}>{busy === `sync-${p.id}` ? <Spinner /> : <Icon name="refresh" size="sm" />}Sync</button>}
                {p.status === "PENDING" && p.awaiting_registration && <button className="btn sm" disabled={!!busy} onClick={() => act(`tok-${p.id}`, async () => setIssued(await api<AdminPartner>("POST", `/admin/partners/${p.id}/token`)), "New registration token issued")}><Icon name="keyRound" size="sm" />New token</button>}
                <button className="btn sm ghost" disabled={!!busy} onClick={() => act(`del-${p.id}`, () => api("DELETE", `/admin/partners/${p.id}`), "Disconnected")}>Disconnect</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {config.simulator && (
        <section className="panel section">
          <div className="panel-head"><h2>CPO simulator</h2><span className="tag right">Test network</span></div>
          <div className="panel-body row gap-16 wrap">
            <div className="grow" style={{ minWidth: 260 }}>
              <p>Three fictional operators with {sim?.sites ?? 12} HGV sites, speaking real OCPI to this app: calendars, asynchronous confirmations, changes, cancellations, plate + Autocharge/Plug & Charge arrival, sessions and CDRs.</p>
              {sim && <p className="small muted" style={{ marginTop: 6 }}>{sim.registered ? `Registered. ${sim.bookings} bookings, ${sim.active_sessions} charging.` : "Not registered yet."}</p>}
            </div>
            <button className="btn" disabled={!!busy} onClick={() => act("sim", () => api("POST", "/admin/simulator/connect"), simPartner ? "Simulator data refreshed" : "Simulator connected")}>
              {busy === "sim" ? <Spinner /> : <Icon name="plug" size="sm" />}{simPartner ? "Refresh simulator" : "Connect simulator"}
            </button>
          </div>
        </section>
      )}

      <section className="panel section">
        <div className="panel-head"><h2>Your OCPI details</h2></div>
        <div className="panel-body stack gap-12">
          <p className="small muted">Give operators your versions URL. Endpoints: credentials, locations, tariffs, sessions, cdrs (receiver), tokens (sender, with real-time authorise) and bookings (receiver).</p>
          <CopyRow label="Versions URL" value={config.ocpi_versions_url} />
          <div className="row gap-24 wrap small">
            <span>Role <b>EMSP</b></span>
            <span>Country code <b>{config.party.country_code}</b></span>
            <span>Party ID <b>{config.party.party_id}</b></span>
            <span>Business name <b>{config.party.name}</b></span>
          </div>
        </div>
      </section>

      <MessageLog />

      {dialog === "connect" && <ConnectDialog onClose={() => setDialog(null)} onDone={async () => { setDialog(null); await load(); await refreshNetwork(); }} />}
      {dialog === "invite" && <InviteDialog onClose={() => setDialog(null)} onDone={async () => { await load(); }} />}
      {issued && (
        <Modal title="New registration token" onClose={() => setIssued(null)} foot={<button className="btn primary" onClick={() => setIssued(null)}>Done</button>}>
          <div className="stack gap-16">
            <p className="small">Send it to {issued.name} securely. It's shown only now: we keep a hash, not the token. The previous token no longer works.</p>
            <CopyRow label="Versions URL" value={config.ocpi_versions_url} />
            <CopyRow label="Registration token (CREDENTIALS_TOKEN_A)" value={issued.registration_token ?? ""} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="copyfield">
        <input className="input" readOnly value={value} onFocus={(e) => e.target.select()} aria-label={label} />
        <button className="btn" onClick={async () => { if (await copyText(value)) { setCopied(true); setTimeout(() => setCopied(false), 1800); } }}><Icon name={copied ? "check" : "copy"} size="sm" />{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}

function ConnectDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const { api, toast } = useApp();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ counts: Record<string, number> }>("POST", "/admin/partners", { action: "connect", versions_url: url, token, name });
      toast(`Connected. ${r.counts.locations ?? 0} sites and ${r.counts.booking_locations ?? 0} bookable bay types loaded.`);
      onDone();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Registration failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Connect an operator" onClose={onClose} foot={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !url || !token} onClick={go}>{busy && <Spinner />}Connect</button></>}>
      <div className="stack gap-16">
        <p className="small muted">The operator gives you their versions URL and a registration token (CREDENTIALS_TOKEN_A). We fetch their endpoints, register with our own token and pull their sites, prices and calendars.</p>
        <Field label="Versions URL">{(id) => <input id={id} className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://ocpi.operator.example/versions" />}</Field>
        <Field label="Registration token">{(id) => <input id={id} className="input" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" style={{ fontFamily: "var(--mono)" }} />}</Field>
        <Field label="Display name" hint="Optional. Otherwise taken from their credentials">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

function InviteDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const { api, config } = useApp();
  const [name, setName] = useState("");
  const [partner, setPartner] = useState<AdminPartner | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      setPartner(await api<AdminPartner>("POST", "/admin/partners", { action: "invite", name }));
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Invite an operator" onClose={onClose} foot={partner ? <button className="btn primary" onClick={onClose}>Done</button> : <><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={create}>{busy && <Spinner />}Create registration token</button></>}>
      {partner ? (
        <div className="stack gap-16">
          <p className="small">Send both values to the operator securely. They register by POSTing their credentials to us with this token; it works once. Copy it now: it isn't shown again (we only keep a hash).</p>
          <CopyRow label="Versions URL" value={config.ocpi_versions_url} />
          <CopyRow label="Registration token (CREDENTIALS_TOKEN_A)" value={partner.registration_token ?? ""} />
        </div>
      ) : (
        <div className="stack gap-16">
          <p className="small muted">Use this when the operator should start the OCPI registration.</p>
          <Field label="Operator name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Midlands Truck Charging" />}</Field>
        </div>
      )}
    </Modal>
  );
}

function MessageLog() {
  const { api, now } = useApp();
  const [module, setModule] = useState("");
  const [rows, setRows] = useState<OcpiLogEntry[] | null>(null);
  const [open, setOpen] = useState<OcpiLogEntry | null>(null);
  const [limit, setLimit] = useState(30);
  const load = useCallback(async () => setRows(await api<OcpiLogEntry[]>("GET", `/admin/log?limit=150${module ? `&module=${module}` : ""}`)), [api, module]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <section className="panel section">
      <div className="panel-head wrap">
        <h2>OCPI messages</h2>
        <div className="right"><Seg label="Module" value={module} onChange={setModule} options={[{ value: "", label: "All" }, { value: "bookings", label: "Bookings" }, { value: "tokens", label: "Tokens" }, { value: "sessions", label: "Sessions" }, { value: "cdrs", label: "CDRs" }, { value: "credentials", label: "Credentials" }]} /></div>
      </div>
      {!rows ? <div className="empty"><Spinner /></div> : rows.length === 0 ? <Empty title="No messages yet">Requests to and from operators appear here as they happen.</Empty> : (
        <ul className="list">
          {rows.slice(0, limit).map((r) => (
            <li key={r.id} className="log-row" role="button" tabIndex={0} onClick={() => setOpen(r)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(r); }}>
              <span className="num xs muted">{fmtTime(r.at)}</span>
              <span title={r.direction === "IN" ? "Received" : "Sent"}><Icon name={r.direction === "IN" ? "arrowDownLeft" : "arrowUpRight"} size="sm" /></span>
              <span className="small" style={{ fontWeight: 600 }}>{r.method}</span>
              <span className="path" title={r.url}>{r.url.replace(/^https?:\/\/[^/]+/, "")}</span>
              <span className={`tag ${r.status_code && r.status_code < 2000 ? "ok" : "bad"}`}>{r.status_code ?? r.http_status ?? "—"}</span>
              <span className="xs muted hide-sm">{r.party ?? ""}</span>
            </li>
          ))}
          {rows.length > limit && (
            <li style={{ padding: "10px 14px" }}>
              <button type="button" className="btn sm ghost" onClick={() => setLimit(limit + 50)}>Show {Math.min(50, rows.length - limit)} older messages</button>
            </li>
          )}
        </ul>
      )}
      {open && (
        <Modal title={`${open.direction === "IN" ? "Received" : "Sent"} ${open.method}`} onClose={() => setOpen(null)}>
          <div className="stack gap-12">
            <div className="small" style={{ fontFamily: "var(--mono)", overflowWrap: "anywhere" }}>{open.url}</div>
            <dl className="kv">
              <dt>When</dt><dd>{fmtDateTime(open.at, now)}</dd>
              <dt>Party</dt><dd>{open.party ?? "—"}</dd>
              <dt>Status</dt><dd>HTTP {open.http_status ?? "—"}, OCPI {open.status_code ?? "—"}{open.duration_ms != null ? `, ${open.duration_ms} ms` : ""}</dd>
              <dt>X-Request-ID</dt><dd>{open.request_id ?? "—"}</dd>
            </dl>
            {open.request_body != null && <><div className="small muted">Request</div><Json value={open.request_body} /></>}
            <div className="small muted">Response</div>
            <Json value={open.response_body} />
          </div>
        </Modal>
      )}
    </section>
  );
}
