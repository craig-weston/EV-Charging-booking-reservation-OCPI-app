// Step-by-step guide to connecting a real charge point operator over OCPI 2.3.0, after trying the
// simulator. Each step's state comes from the platform itself (readiness checks, partners, bookings),
// so the guide picks up where you left off.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Readiness, ReadinessCheck } from "../../shared/model";
import type { ProbeReport } from "../../server/ocpi/probe";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { href } from "../app/router";
import { fmtRelative } from "../app/format";
import { Field, Icon, Seg, Spinner, copyText } from "../ui/ui";
import type { IconName } from "../ui/icon-data";
import { CopyRow, InviteDialog, type AdminPartner } from "./Network";

type StepId = "ready" | "find" | "check" | "confirm" | "book" | "live";

/** What we need from an operator, in the order the guide explains it. */
const MODULES: { id: string; role: "SENDER" | "RECEIVER"; label: string; why: string; required: boolean }[] = [
  { id: "credentials", role: "SENDER", label: "Credentials", why: "Registration and token exchange", required: true },
  { id: "locations", role: "SENDER", label: "Locations", why: "Sites, bays and connectors", required: true },
  { id: "bookings", role: "SENDER", label: "Bookings", why: "Booking requests, bookable bays and calendars", required: true },
  { id: "tariffs", role: "SENDER", label: "Tariffs", why: "Prices shown before booking", required: false },
  { id: "sessions", role: "RECEIVER", label: "Sessions", why: "Live charging progress (they push to us)", required: false },
  { id: "cdrs", role: "RECEIVER", label: "CDRs", why: "Charge records for billing (they push to us)", required: false },
];

export function OperatorGuidePage() {
  const { api, config, network, bookings, toast, refreshNetwork } = useApp();
  const [ready, setReady] = useState<Readiness | null>(null);
  const [partners, setPartners] = useState<AdminPartner[] | null>(null);
  const [open, setOpen] = useState<StepId | "none" | null>(null);

  const load = useCallback(async () => {
    const [r, p] = await Promise.all([api<Readiness>("GET", "/admin/readiness"), api<AdminPartner[]>("GET", "/admin/partners")]);
    setReady(r);
    setPartners(p);
  }, [api]);
  useEffect(() => { void load().catch((e) => toast(e instanceof Error ? e.message : "Couldn't load the guide", "bad")); }, [load, toast]);

  const real = useMemo(() => (partners ?? []).filter((p) => !p.is_simulator && p.status !== "REMOVED"), [partners]);
  const connected = real.find((p) => p.status === "CONNECTED") ?? null;
  const sitesFor = (p: AdminPartner) => {
    const parties = new Set(p.roles.map((r) => `${r.country_code}*${r.party_id}`.toUpperCase()));
    return (network?.locations ?? []).filter((l) => parties.has(`${l.country_code}*${l.party_id}`.toUpperCase())).length;
  };
  const realBooking = connected ? bookings.find((b) => b.partner_id === connected.id) : undefined;

  const done: Record<StepId, boolean> = {
    ready: !!ready && !ready.checks.some((c) => c.level === "todo"),
    find: real.length > 0,
    check: real.length > 0,
    confirm: !!connected && sitesFor(connected) > 0,
    book: !!realBooking,
    live: !!ready && !ready.simulator && !ready.simulator_connected,
  };
  const order: StepId[] = ["ready", "find", "check", "confirm", "book", "live"];
  const current = order.find((s) => !done[s]) ?? null;
  const shown = open ?? current;
  const doneCount = order.filter((s) => done[s]).length;
  const toggle = (s: StepId) => setOpen(shown === s ? "none" : s);
  const after = async () => { setOpen(null); await load(); await refreshNetwork(); };

  if (!ready || !partners) return <div className="page"><div className="panel"><div className="empty"><Spinner /></div></div></div>;

  return (
    <div className="page guide">
      <div className="page-head">
        <div>
          <a className="xs muted back-link" href={href("/network")}><Icon name="chevronLeft" size="sm" />Network</a>
          <h1>Connect a real operator</h1>
          <div className="sub">You've tried the simulator. These steps take you to booking real bays at a real operator's sites.</div>
        </div>
      </div>

      <div className="guide-progress" role="progressbar" aria-valuemin={0} aria-valuemax={order.length} aria-valuenow={doneCount} aria-label="Steps done">
        <div className="guide-progress-bar"><span style={{ width: `${(doneCount / order.length) * 100}%` }} /></div>
        <span className="small muted">{doneCount === order.length ? "All done. You're live." : `${doneCount} of ${order.length} steps done`}</span>
      </div>

      <ol className="guide-steps">
        <Step n={1} id="ready" icon="shieldCheck" title="Get your platform ready" summary={done.ready ? "Everything an operator checks is in place" : "A few settings to sort before you contact anyone"} done={done.ready} current={current === "ready"} open={shown === "ready"} onToggle={toggle}>
          <p className="small muted">Operators check these before they agree to connect. Items marked "worth fixing" won't stop a connection.</p>
          <ul className="guide-checks">{ready.checks.map((c) => <CheckRow key={c.id} c={c} />)}</ul>
          <p className="xs muted">Variables and secrets are set in Cloudflare: Workers &amp; Pages → your Worker → Settings → Variables and secrets. <button type="button" className="linkish" onClick={() => void load()}>Check again</button></p>
        </Step>

        <Step n={2} id="find" icon="search" title="Find an operator that takes bookings" summary={done.find ? `Talking to ${real.map((p) => p.name).join(", ")}` : "Not every network supports OCPI bookings yet"} done={done.find} current={current === "find"} open={shown === "find"} onToggle={toggle}>
          <p className="small">You need an operator whose platform speaks <b>OCPI 2.3.0 with the Bookings module</b>. Ask their roaming or partnerships team. Many networks connect through a hub or a back-office platform; that's fine, as long as it offers 2.3.0 bookings.</p>
          <div className="guide-two">
            <div>
              <h3 className="guide-h3">Ask them for</h3>
              <ul className="guide-list">
                <li>OCPI 2.3.0 with Bookings, Locations, Tariffs, Sessions and CDRs</li>
                <li>Bays that open for the number plate (ANPR) or need no access control</li>
                <li>Plug &amp; Charge or Autocharge, so drivers need no card</li>
                <li>A test environment first, if they have one</li>
                <li>Their commercial terms for eMSP roaming</li>
              </ul>
            </div>
            <div>
              <h3 className="guide-h3">They'll ask you for</h3>
              <ul className="guide-list">
                <li>Your company details and a signed roaming agreement</li>
                <li>Your OCPI party ID: <b>{config.party.country_code}*{config.party.party_id}</b></li>
                <li>Your versions URL (it's in the message below)</li>
                <li>A technical contact and a security contact</li>
              </ul>
            </div>
          </div>
          <IntroMessage />
        </Step>

        <Step n={3} id="check" icon="link" title="Check their interface, then connect" summary={done.check ? `${real.length === 1 ? real[0].name : `${real.length} operators`} added` : "Test their details before registering"} done={done.check} current={current === "check"} open={shown === "check"} onToggle={toggle}>
          <ConnectStep onDone={after} />
        </Step>

        <Step n={4} id="confirm" icon="badgeCheck" title="Confirm sites and calendars came through" summary={connected ? `${connected.name}: ${sitesFor(connected)} sites` : real.length ? "Waiting for the operator to register" : "After you connect"} done={done.confirm} current={current === "confirm"} open={shown === "confirm"} onToggle={toggle}>
          {real.length === 0 ? <p className="small muted">Connect an operator in step 3 first.</p> : real.map((p) => <PartnerCheck key={p.id} p={p} sites={sitesFor(p)} onSynced={after} />)}
        </Step>

        <Step n={5} id="book" icon="book" title="Make a test booking" summary={realBooking ? "Booked: check it through to the charge record" : "One real booking, end to end"} done={done.book} current={current === "book"} open={shown === "book"} onToggle={toggle}>
          <p className="small">Book a slot at one of {connected?.name ?? "their"} sites, ideally with the operator watching their side. Check that:</p>
          <ul className="guide-list">
            <li>The booking is confirmed (it may say "Waiting for operator" for a few seconds)</li>
            <li>Changing the time and cancelling both reach the operator</li>
            <li>The truck's plate opens the site and the charger starts without a card</li>
            <li>After charging, the charge record appears on the booking</li>
          </ul>
          <a className="btn primary" href={href("/book")}><Icon name="book" size="sm" />Book a slot</a>
        </Step>

        <Step n={6} id="live" icon="zap" title="Switch off the simulator" summary={done.live ? "Only real operators are shown" : "So planners only see real sites"} done={done.live} current={current === "live"} open={shown === "live"} onToggle={toggle}>
          <ol className="guide-list numbered">
            <li className={ready.simulator_connected ? "" : "struck"}>On the <a href={href("/network")}>Network page</a>, press <b>Disconnect</b> next to the CPO simulator. Its test sites disappear from booking.{!ready.simulator_connected && " Done."}</li>
            <li className={ready.simulator ? "" : "struck"}>In Cloudflare, set <code>ENABLE_CPO_SIMULATOR</code> to <code>false</code> (or delete it) and deploy.{!ready.simulator && " Done."}</li>
          </ol>
          <p className="xs muted">You can switch it back on any time to demo or test without touching real sites.</p>
        </Step>
      </ol>
    </div>
  );
}

function Step({ n, id, icon, title, summary, done, current, open, onToggle, children }: { n: number; id: StepId; icon: IconName; title: string; summary: string; done: boolean; current: boolean; open: boolean; onToggle(s: StepId): void; children: ReactNode }) {
  const bodyId = `guide-${id}`;
  return (
    <li className={`guide-step panel ${done ? "done" : ""} ${current ? "current" : ""} ${open ? "open" : ""}`}>
      <button type="button" className="guide-step-head" aria-expanded={open} aria-controls={bodyId} onClick={() => onToggle(id)}>
        <span className="guide-num" aria-hidden="true">{done ? <Icon name="check" size="sm" /> : n}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="guide-title"><Icon name={icon} size="sm" />{title}{current && !done && <span className="tag">Next</span>}</span>
          <span className="guide-summary small muted">{summary}</span>
        </span>
        <Icon name="chevronDown" size="sm" className="guide-chev" />
      </button>
      {open && <div className="guide-body" id={bodyId}>{children}</div>}
    </li>
  );
}

function CheckRow({ c }: { c: ReadinessCheck }) {
  const label = c.level === "ok" ? "Done" : c.level === "warn" ? "Worth fixing" : "To do";
  return (
    <li className={`guide-check ${c.level}`}>
      <span className="guide-check-icon" aria-hidden="true"><Icon name={c.level === "ok" ? "circleCheck" : c.level === "warn" ? "info" : "alert"} size="sm" /></span>
      <span className="grow" style={{ minWidth: 0 }}>
        <b>{c.title}</b> <span className="sr-only">({label})</span>
        <span className="small muted guide-check-detail">{c.detail}</span>
      </span>
      <span className={`tag ${c.level === "ok" ? "ok" : c.level === "todo" ? "bad" : ""} hide-sm`}>{label}</span>
    </li>
  );
}

function IntroMessage() {
  const { config, brand } = useApp();
  const [copied, setCopied] = useState(false);
  const text = `Hello,

We're ${config.party.name}. We use ${brand.name}, an OCPI 2.3.0 eMSP platform, to book HGV charging for our fleet, and we'd like to book bays at your sites.

Could we set up an OCPI 2.3.0 connection including the Bookings module? Our details:
- Role: EMSP
- Country code / party ID: ${config.party.country_code} / ${config.party.party_id}
- Versions URL: ${config.ocpi_versions_url}

We use Credentials, Locations, Tariffs, Bookings (booking locations and calendars), Tokens with real-time authorisation, Sessions and CDRs. Our trucks arrive by number plate and start with Plug & Charge or Autocharge.

To connect, you can send us your versions URL and a registration token (CREDENTIALS_TOKEN_A), or we can send you one. A test environment first would be ideal.

Thanks,`;
  return (
    <div className="guide-message">
      <div className="row gap-8" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 className="guide-h3" style={{ margin: 0 }}>A first message you can send</h3>
        <button type="button" className="btn sm" onClick={async () => { if (await copyText(text)) { setCopied(true); setTimeout(() => setCopied(false), 1800); } }}><Icon name={copied ? "check" : "copy"} size="sm" />{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre className="guide-pre">{text}</pre>
    </div>
  );
}

function ConnectStep({ onDone }: { onDone(): Promise<void> }) {
  const { api, config, toast } = useApp();
  const [who, setWho] = useState<"them" | "us">("them");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"probe" | "connect" | null>(null);
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState(false);

  const run = async (kind: "probe" | "connect") => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === "probe") setReport(await api<ProbeReport>("POST", "/admin/probe", { versions_url: url, token }));
      else {
        const r = await api<{ counts: Record<string, number> }>("POST", "/admin/partners", { action: "connect", versions_url: url, token });
        toast(`Connected. ${r.counts.locations ?? 0} sites and ${r.counts.booking_locations ?? 0} bookable bay types loaded.`);
        setUrl(""); setToken(""); setReport(null);
        await onDone();
      }
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : kind === "probe" ? "The check didn't run" : "Registration failed");
    } finally {
      setBusy(null);
    }
  };

  const fails = report?.findings.filter((f) => f.level === "fail") ?? [];
  const warns = report?.findings.filter((f) => f.level === "warn") ?? [];
  const passes = report?.findings.filter((f) => f.level === "pass") ?? [];

  return (
    <div className="stack gap-16">
      <Seg<"them" | "us"> label="Who starts the connection" full value={who} onChange={setWho} options={[{ value: "them", label: "They sent me a URL and token" }, { value: "us", label: "They want details from me" }]} />

      {who === "them" ? (
        <>
          <p className="small muted">Paste what they sent. <b>Check</b> only reads their interface (it never registers or books), so you can spot problems before connecting.</p>
          <div className="guide-form">
            <Field label="Their versions URL">{(id) => <input id={id} className="input" value={url} onChange={(e) => { setUrl(e.target.value); setReport(null); }} placeholder="https://ocpi.operator.example/versions" inputMode="url" autoComplete="off" />}</Field>
            <Field label="Registration token" hint="CREDENTIALS_TOKEN_A. It works once.">{(id) => <input id={id} className="input" style={{ fontFamily: "var(--mono)" }} value={token} onChange={(e) => { setToken(e.target.value); setReport(null); }} autoComplete="off" spellCheck={false} />}</Field>
          </div>
          <div className="row gap-8 wrap">
            <button type="button" className="btn" disabled={!url || !token || !!busy} onClick={() => run("probe")}>{busy === "probe" ? <Spinner /> : <Icon name="activity" size="sm" />}Check their interface</button>
            <button type="button" className="btn primary" disabled={!url || !token || !!busy} onClick={() => run("connect")}>{busy === "connect" ? <Spinner /> : <Icon name="link" size="sm" />}Connect</button>
          </div>
          {error && <div className="error-text" role="alert">{error}</div>}
          {report && (
            <div className={`guide-report ${report.ok ? "ok" : "bad"}`} role="status">
              <div className="guide-report-head">
                <Icon name={report.ok ? "circleCheck" : "circleX"} />
                <b>{report.ok ? "Looks good to connect" : "Fix these before connecting"}</b>
                <span className="xs muted">{passes.length} passed · {warns.length} warnings · {fails.length} problems</span>
              </div>
              <ul className="guide-findings">
                {[...fails, ...warns].map((f, i) => <li key={i} className={f.level}><Icon name={f.level === "fail" ? "circleX" : "alert"} size="sm" /><span><b>{f.area}</b> {f.text}</span></li>)}
                {passes.map((f, i) => <li key={`p${i}`} className="pass"><Icon name="check" size="sm" /><span><b>{f.area}</b> {f.text}</span></li>)}
              </ul>
              {report.ok && <p className="xs muted">With a registration token, only versions and credentials can be read. Sites and calendars are pulled once you connect.</p>}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="small muted">Create a one-time registration token and send it with your versions URL. When they register, they appear in step 4.</p>
          <CopyRow label="Your versions URL" value={config.ocpi_versions_url} />
          <div><button type="button" className="btn primary" onClick={() => setInvite(true)}><Icon name="keyRound" size="sm" />Create a registration token</button></div>
          <p className="xs muted">Send the token separately from the URL (for example, the token by phone or a password manager share), never in a public channel.</p>
        </>
      )}
      {invite && <InviteDialog onClose={() => setInvite(false)} onDone={onDone} />}
    </div>
  );
}

function PartnerCheck({ p, sites, onSynced }: { p: AdminPartner; sites: number; onSynced(): Promise<void> }) {
  const { api, network, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const parties = new Set(p.roles.map((r) => `${r.country_code}*${r.party_id}`.toUpperCase()));
  const bays = (network?.booking_locations ?? []).filter((b) => parties.has(`${b.country_code}*${b.party_id}`.toUpperCase()));
  const withCal = bays.filter((b) => (b.data.calendars ?? []).length > 0).length;
  const has = (id: string, role: string) => p.endpoints.some((e) => e.identifier === id && e.role === role);
  const sync = async () => {
    setBusy(true);
    try {
      await api("POST", `/admin/partners/${p.id}/sync`);
      toast("Sites and calendars refreshed");
      await onSynced();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Sync failed", "bad");
    } finally {
      setBusy(false);
    }
  };
  if (p.status !== "CONNECTED") {
    return (
      <div className="guide-partner">
        <div className="row gap-8 wrap" style={{ alignItems: "center" }}><span className="status pending">Waiting</span><b>{p.name}</b></div>
        <p className="small muted">They haven't registered yet. They need your versions URL and the registration token ending <code>{p.token_hint ?? "…"}</code>. Lost it? Issue a new one on the <a href={href("/network")}>Network page</a>.</p>
      </div>
    );
  }
  return (
    <div className="guide-partner">
      <div className="row gap-8 wrap" style={{ alignItems: "center" }}>
        <span className="status ok">Connected</span><b className="grow">{p.name}</b>
        <button type="button" className="btn sm" disabled={busy} onClick={sync}>{busy ? <Spinner /> : <Icon name="refresh" size="sm" />}Sync now</button>
      </div>
      <div className="guide-stats">
        <div><b>{sites}</b><span className="xs muted">sites</span></div>
        <div><b>{bays.length}</b><span className="xs muted">bookable bay types</span></div>
        <div><b>{withCal}</b><span className="xs muted">with calendars</span></div>
      </div>
      <ul className="guide-modules">
        {MODULES.map((m) => {
          // Sessions and CDRs are pushed to our endpoints, so their side doesn't list them.
          const ok = m.role === "RECEIVER" ? true : has(m.id, m.role) || (m.id === "credentials" && has("credentials", "RECEIVER"));
          return (
            <li key={m.id} className={ok ? "ok" : m.required ? "bad" : "warn"}>
              <Icon name={ok ? "check" : m.required ? "circleX" : "alert"} size="sm" />
              <span><b>{m.label}</b> <span className="xs muted">{m.role === "RECEIVER" ? "They send these to us when charging happens" : m.why}</span></span>
            </li>
          );
        })}
      </ul>
      {sites === 0 && <p className="small">No sites yet. Ask the operator whether their sites are published to your party ID ({p.roles[0] ? `they registered as ${p.roles[0].country_code}*${p.roles[0].party_id}` : "check their roles"}), then press Sync now.</p>}
      {sites > 0 && withCal === 0 && <p className="small">Sites came through but no calendars, so no free slots can be shown. Ask them to publish booking calendars for their bookable bays.</p>}
      <p className="xs muted">{p.version ? `OCPI ${p.version}. ` : ""}{p.last_sync_at ? `Last synced ${fmtRelative(p.last_sync_at)}.` : "Not synced yet."}</p>
    </div>
  );
}
