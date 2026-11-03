// Settings → Security & compliance (platform admins): the Cyber Essentials readiness checklist,
// company details for the legal pages, certificates, account recovery and key rotation.
// Cyber Essentials certifies the organisation that runs this platform, not the app; this page
// gathers what the app can check by itself and the evidence for what only people can do.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AuditEntry, Certification, CertificationScheme, LegalInfo } from "../../shared/model";
import { EMPTY_LEGAL } from "../../shared/model";
import { COMPLIANCE_AREAS, type CheckStatus, type ComplianceArea, type ComplianceCheck } from "../../shared/compliance";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { href } from "../app/router";
import { fmtDateTime } from "../app/format";
import { Field, Icon, Modal, Spinner } from "../ui/ui";
import type { IconName } from "../ui/icon-data";
import { MfaEnrol } from "./Security";
import { MoreList, MoreRow, usePrintOpensRows } from "../components/More";

interface Report {
  generated_at: string;
  mode: "live" | "demo";
  checks: ComplianceCheck[];
}

const STATUS: Record<CheckStatus, { label: string; tone: string }> = {
  pass: { label: "Done", tone: "ok" },
  fail: { label: "Action needed", tone: "bad" },
  warn: { label: "Check", tone: "pending" },
  todo: { label: "To do", tone: "muted" },
  info: { label: "Demo", tone: "info" },
};

const AREA_ICON: Record<ComplianceArea, IconName> = {
  Firewalls: "shield",
  "Secure configuration": "sliders",
  "User access control": "keyRound",
  "Malware protection": "scan",
  "Security update management": "refresh",
  "Data protection": "fileText",
};

const IASME_SEARCH = "https://iasme.co.uk/cyber-essentials/ncsc-certificate-search/";
/** What needs doing first: things that failed, then things to check, then to-dos; done last. */
const ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, todo: 2, info: 3, pass: 4 };
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtDay = (d: string) => { const t = new Date(`${d}T12:00:00Z`); return Number.isNaN(t.getTime()) ? d : DAY.format(t); };

/** Platform admin pages need two-step verification in live mode: this asks for it in place. */
export function AdminMfaGate({ children }: { children: React.ReactNode }) {
  const { me, backend, brand, refreshMe, toast } = useApp();
  const [open, setOpen] = useState(false);
  if (!me?.mfa?.admin_required || me.mfa.aal === "aal2" || !backend.auth) return <>{children}</>;
  return (
    <div className="page">
      <div className="gate panel">
        <div className="panel-body stack gap-12">
          <div className="sec-title"><Icon name="shieldCheck" />Admin pages need two-step verification</div>
          <p className="small muted">Platform administrators can change things that affect every fleet, so Cyber Essentials (and we) expect a second factor for them. Add an authenticator app to your account, then this page opens.</p>
          <div><button className="btn primary" onClick={() => setOpen(true)}>Set up two-step verification</button></div>
        </div>
      </div>
      {open && (
        <Modal title="Set up two-step verification" onClose={() => setOpen(false)}>
          <MfaEnrol auth={backend.auth} label={`${brand.name} (${me.user.email ?? "admin"})`} onCancel={() => setOpen(false)} onDone={() => { setOpen(false); void refreshMe(); toast("Two-step verification is on"); }} />
        </Modal>
      )}
    </div>
  );
}

export function CompliancePage() {
  return (
    <AdminMfaGate>
      <ComplianceInner />
    </AdminMfaGate>
  );
}

function ComplianceInner() {
  const { api, toast, now } = useApp();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReport(await api<Report>("GET", "/admin/compliance"));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't load the checklist");
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const tick = async (id: string, done: boolean, note: string | null) => {
    try {
      setReport(await api<Report>("PUT", `/admin/compliance/${id}`, { done, note }));
      toast(done ? "Marked as done" : "Marked as to do");
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't save that", "bad");
    }
  };

  const byArea = useMemo(() => {
    const m = new Map<ComplianceArea, ComplianceCheck[]>();
    for (const a of COMPLIANCE_AREAS) m.set(a, []);
    for (const c of report?.checks ?? []) m.get(c.area)?.push(c);
    return m;
  }, [report]);
  const counted = (report?.checks ?? []).filter((c) => c.status !== "info");
  const done = counted.filter((c) => c.status === "pass").length;
  const blocking = counted.filter((c) => c.status === "fail").length;
  const sorted = (area: ComplianceArea) => [...(byArea.get(area) ?? [])].sort((x, y) => ORDER[x.status] - ORDER[y.status]);
  const next = COMPLIANCE_AREAS.flatMap(sorted).filter((c) => c.status !== "pass" && c.status !== "info").sort((x, y) => ORDER[x.status] - ORDER[y.status])[0];
  usePrintOpensRows();

  return (
    <div className="page compliance">
      <div className="page-head">
        <div>
          <h1>Security & compliance</h1>
          <div className="sub">
            {report
              ? <>Cyber Essentials readiness: <b>{done} of {counted.length}</b> done{blocking ? <>, <span className="cx-bad">{blocking} need{blocking === 1 ? "s" : ""} action</span></> : null}.{next ? <> Next: {next.title}.</> : " Ready for the self-assessment."}</>
              : "Get this deployment ready for Cyber Essentials and keep the evidence in one place."}
          </div>
        </div>
        <div className="actions no-print">
          <a className="btn ghost" href={href("/legal/security")}><Icon name="eye" size="sm" />View public security page</a>
          <button className="btn" onClick={() => window.print()}><Icon name="fileText" size="sm" />Print evidence</button>
        </div>
      </div>
      {report && <div className="cx-progress" aria-hidden="true"><span style={{ width: `${counted.length ? (done / counted.length) * 100 : 0}%` }} /></div>}

      {error && <div className="error-text" role="alert">{error}</div>}
      {!report && !error && <div className="skeleton" style={{ height: 240, marginTop: 16 }} />}

      {report && (
        <>
          <MoreList label="Cyber Essentials checklist" className="cx-list">
            <MoreRow icon="circleHelp" title="How certification works" summary="It certifies your organisation, not the app. A director signs it off, and it lasts 12 months.">
              <div className="stack gap-8">
                <p className="small" style={{ margin: 0 }}>
                  Cyber Essentials certifies <b>your organisation</b>: its devices, accounts, networks and the cloud services it uses (here Cloudflare, Supabase,
                  GitHub and your email). The app checks its own items below; you tick the rest with a note of the evidence. Then complete the
                  self-assessment with an IASME certification body.
                </p>
                <p className="xs muted" style={{ margin: 0 }}>Based on the Cyber Essentials Requirements for IT Infrastructure v3.3 (the "Danzell" question set, used since April 2026). Policies and the full readiness pack are in <code>docs/compliance</code> in the code repository.</p>
              </div>
            </MoreRow>
            {COMPLIANCE_AREAS.map((area) => {
              const items = sorted(area);
              const scored = items.filter((c) => c.status !== "info");
              const ok = scored.filter((c) => c.status === "pass").length;
              const bad = scored.filter((c) => c.status === "fail").length;
              const first = items.find((c) => c.status !== "pass" && c.status !== "info");
              const all = scored.length > 0 && ok === scored.length;
              const summary = all ? `All ${scored.length} done` : `${ok} of ${scored.length} done${bad ? ` · ${bad} need${bad === 1 ? "s" : ""} action` : ""}${first ? ` · Next: ${first.title}` : ""}`;
              return (
                <MoreRow key={area} icon={AREA_ICON[area]} title={area} summary={summary} tone={bad ? "bad" : all ? "ok" : undefined} flush>
                  <ul className="list check-list">
                    {items.map((c) => <CheckRow key={c.id} c={c} now={now} onTick={tick} />)}
                  </ul>
                </MoreRow>
              );
            })}
          </MoreList>
          <p className="xs muted cx-checked">Checked {fmtDateTime(report.generated_at, now)}{report.mode === "demo" ? ". Demo mode: automatic checks that need a real deployment show as \"Demo\"" : ""}.</p>
        </>
      )}

      <MoreList label="Your organisation">
        <Certificates onSaved={load} />
        <CompanyDetails onSaved={load} />
        <AccountRecovery />
        <KeyRotation />
        <PlatformAudit />
      </MoreList>
    </div>
  );
}

function CheckRow({ c, now, onTick }: { c: ComplianceCheck; now: Date; onTick(id: string, done: boolean, note: string | null): Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const s = STATUS[c.status];
  const save = async (done: boolean) => {
    setBusy(true);
    await onTick(c.id, done, done ? note.trim() || null : null);
    setBusy(false);
    setEditing(false);
    setNote("");
  };
  return (
    <li className="check-row">
      <span className={`status ${s.tone}`}>{s.label}</span>
      <div className="grow stack gap-4">
        <div className="check-title">{c.title}</div>
        <div className="small muted">{c.detail}</div>
        {c.kind === "auto" && c.evidence && <div className="xs evidence"><Icon name="activity" size="sm" />Checked automatically: {c.evidence}</div>}
        {c.kind === "manual" && c.status === "pass" && (
          <div className="xs evidence"><Icon name="check" size="sm" />Done by {c.done_by} {c.done_at ? fmtDateTime(c.done_at, now) : ""}{c.evidence ? `: ${c.evidence}` : ""}</div>
        )}
        {editing && (
          <div className="row gap-8 wrap no-print" style={{ marginTop: 6 }}>
            <input className="input grow" style={{ minWidth: 200 }} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Evidence, e.g. “MFA on for all 4 Supabase members, screenshot in the CE folder”" aria-label={`Evidence for ${c.title}`} autoFocus />
            <button className="btn sm primary" disabled={busy} onClick={() => void save(true)}>{busy && <Spinner />}Save</button>
            <button className="btn sm ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        )}
      </div>
      {c.kind === "manual" && !editing && (
        <div className="no-print">
          {c.status === "pass"
            ? <button className="btn sm ghost" onClick={() => void save(false)} disabled={busy}>Undo</button>
            : <button className="btn sm" onClick={() => setEditing(true)}>Mark done</button>}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------------ certificates

const SCHEMES: CertificationScheme[] = ["Cyber Essentials", "Cyber Essentials Plus", "ISO/IEC 27001"];

function addYear(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function Certificates({ onSaved }: { onSaved(): void }) {
  const { api, toast, refreshConfig, now } = useApp();
  const [list, setList] = useState<Certification[] | null>(null);
  const [draft, setDraft] = useState<Certification | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<Certification[]>("GET", "/admin/certifications").then(setList).catch(() => setList([])); }, [api]);
  const today = now.toISOString().slice(0, 10);

  const save = async (next: Certification[]) => {
    setBusy(true);
    setError(null);
    try {
      setList(await api<Certification[]>("PUT", "/admin/certifications", { certifications: next }));
      setDraft(null);
      await refreshConfig();
      onSaved();
      toast("Certificates saved");
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't save the certificate");
    } finally {
      setBusy(false);
    }
  };
  const set = <K extends keyof Certification>(k: K, v: Certification[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  const valid = (list ?? []).filter((c) => c.expires_on >= today).sort((x, y) => y.expires_on.localeCompare(x.expires_on));
  const renewSoon = valid.length > 0 && new Date(`${valid[0].expires_on}T12:00:00Z`).getTime() - now.getTime() < 60 * 86_400_000;
  const summary = !list ? "Loading…"
    : valid.length ? `${valid[0].scheme}, valid until ${fmtDay(valid[0].expires_on)}${renewSoon ? ": renew soon" : ""}`
    : list.length ? "Expired: add the renewed certificate to show it again"
    : "None yet. Add one once it's issued.";

  return (
    <MoreRow icon="badgeCheck" title="Certificates" summary={summary} tone={valid.length ? (renewSoon ? "warn" : "ok") : list?.length ? "bad" : undefined} id="certificates">
      <div className="stack gap-12">
        <p className="small muted" style={{ margin: 0 }}>
          Add a certificate once it's issued to your organisation. It shows on the sign-in and security pages with a link to the public
          certificate search, and disappears when it expires. For the official badge, use the files your certification body gives you.
        </p>
        {!list ? <div className="skeleton" style={{ height: 44 }} /> : list.length === 0 && !draft ? (
          <p className="small">No certificates yet.</p>
        ) : (
          <ul className="list">
            {list.map((c, i) => {
              const expired = c.expires_on < today;
              const soon = !expired && new Date(`${c.expires_on}T12:00:00Z`).getTime() - now.getTime() < 60 * 86_400_000;
              return (
                <li key={`${c.scheme}-${c.certificate_number}`} className="row gap-12" style={{ padding: "10px 0" }}>
                  <div className="grow">
                    <div style={{ fontWeight: 600 }}>{c.scheme} · {c.certificate_number}</div>
                    <div className="xs muted">{c.certification_body || "Certification body not given"} · issued {fmtDay(c.issued_on)} · {expired ? "expired" : "valid until"} {fmtDay(c.expires_on)}</div>
                  </div>
                  {expired ? <span className="tag bad">Expired</span> : soon ? <span className="tag warn">Renew soon</span> : <span className="tag ok">Valid</span>}
                  <button className="btn sm ghost" disabled={busy} onClick={() => void save(list.filter((_, j) => j !== i))} aria-label={`Remove ${c.scheme} certificate ${c.certificate_number}`}><Icon name="trash" size="sm" /></button>
                </li>
              );
            })}
          </ul>
        )}
        {draft ? (
          <div className="stack gap-12 cert-form">
            <div className="form-grid">
              <Field label="Scheme">{(id) => (
                <select id={id} className="select" value={draft.scheme} onChange={(e) => {
                  const scheme = e.target.value as CertificationScheme;
                  setDraft((d) => d && ({ ...d, scheme, verify_url: scheme.startsWith("Cyber Essentials") ? IASME_SEARCH : d.verify_url === IASME_SEARCH ? "" : d.verify_url }));
                }}>{SCHEMES.map((s) => <option key={s}>{s}</option>)}</select>
              )}</Field>
              <Field label="Certificate number" hint="Exactly as on the certificate">{(id) => <input id={id} className="input" value={draft.certificate_number} onChange={(e) => set("certificate_number", e.target.value)} />}</Field>
              <Field label="Issued on">{(id) => <input id={id} className="input" type="date" value={draft.issued_on} onChange={(e) => setDraft((d) => d && ({ ...d, issued_on: e.target.value, expires_on: d.scheme.startsWith("Cyber Essentials") && (!d.expires_on || d.expires_on === addYear(d.issued_on)) ? addYear(e.target.value) : d.expires_on }))} />}</Field>
              <Field label="Expires on" hint={draft.scheme.startsWith("Cyber Essentials") ? "Cyber Essentials lasts 12 months" : undefined}>{(id) => <input id={id} className="input" type="date" value={draft.expires_on} onChange={(e) => set("expires_on", e.target.value)} />}</Field>
              <Field label="Certification body">{(id) => <input id={id} className="input" value={draft.certification_body} onChange={(e) => set("certification_body", e.target.value)} placeholder="The IASME certification body that assessed you" />}</Field>
              <Field label="Link to verify it">{(id) => <input id={id} className="input" value={draft.verify_url} onChange={(e) => set("verify_url", e.target.value)} placeholder="https://" />}</Field>
            </div>
            {error && <div className="error-text" role="alert">{error}</div>}
            <div className="row gap-8">
              <button className="btn primary" disabled={busy} onClick={() => void save([...(list ?? []), draft])}>{busy && <Spinner />}Save certificate</button>
              <button className="btn ghost" onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="no-print"><button className="btn sm" onClick={() => setDraft({ scheme: "Cyber Essentials", certificate_number: "", issued_on: today, expires_on: addYear(today), certification_body: "", verify_url: IASME_SEARCH })}><Icon name="plus" size="sm" />Add a certificate</button></div>
        )}
      </div>
    </MoreRow>
  );
}

// ------------------------------------------------------------------ company & legal details

const LEGAL_FIELDS: { key: keyof LegalInfo; label: string; hint?: string; placeholder?: string; span?: boolean; type?: string }[] = [
  { key: "company_name", label: "Registered company name", placeholder: "Example Charging Ltd" },
  { key: "trading_name", label: "Trading name", hint: "If different, e.g. your brand" },
  { key: "company_number", label: "Company number", hint: "From Companies House", placeholder: "12345678" },
  { key: "place_of_registration", label: "Registered in", placeholder: "England and Wales" },
  { key: "registered_office", label: "Registered office address", span: true },
  { key: "vat_number", label: "VAT number", hint: "If registered", placeholder: "GB123456789" },
  { key: "ico_number", label: "ICO registration number", hint: "After paying the data protection fee", placeholder: "ZB123456" },
  { key: "contact_email", label: "Contact email", type: "email" },
  { key: "privacy_email", label: "Data protection email", hint: "For privacy requests and complaints", type: "email" },
  { key: "security_contact", label: "Security contact", hint: "Email or https:// link for vulnerability reports" },
  { key: "email_provider", label: "Email delivery provider", hint: "Sends sign-in emails (a sub-processor)", placeholder: "e.g. Postmark, Amazon SES" },
  { key: "hosting_region", label: "Database region", hint: "Your Supabase project's region", placeholder: "London, UK (AWS eu-west-2)" },
];

/** What UK company and e-commerce rules need on the website. */
const REQUIRED_LEGAL: (keyof LegalInfo)[] = ["company_name", "company_number", "registered_office", "contact_email"];

function CompanyDetails({ onSaved }: { onSaved(): void }) {
  const { api, toast, refreshConfig } = useApp();
  const [saved, setSaved] = useState<LegalInfo | null>(null);
  const [draft, setDraft] = useState<LegalInfo>(EMPTY_LEGAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api<LegalInfo>("GET", "/admin/legal").then((l) => { setSaved(l); setDraft(l); }).catch(() => setSaved(EMPTY_LEGAL)); }, [api]);
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const l = await api<LegalInfo>("PUT", "/admin/legal", draft);
      setSaved(l);
      setDraft(l);
      await refreshConfig();
      onSaved();
      toast("Company details saved. The legal pages use them now.");
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't save the details");
    } finally {
      setBusy(false);
    }
  };
  const missing = saved ? REQUIRED_LEGAL.filter((k) => !saved[k].trim()).length : 0;
  const summary = !saved ? "Loading…"
    : missing === REQUIRED_LEGAL.length ? "Not filled in yet. UK law requires these on your website."
    : missing ? `${missing} required detail${missing === 1 ? "" : "s"} missing from the legal pages`
    : `${saved.company_name} · company ${saved.company_number}`;
  return (
    <MoreRow icon="scale" title="Company & legal" summary={summary} tone={saved ? (missing ? "warn" : "ok") : undefined} id="company">
      <div className="stack gap-12">
        <p className="small muted" style={{ margin: 0 }}>UK company and e-commerce rules require your registered name, number, registered office and a contact email on your website. These fill in the privacy notice, terms, data processing terms and the footer. <a className="no-print" href={href("/legal/privacy")}>Preview the legal pages</a></p>
        {!saved ? <div className="skeleton" style={{ height: 120 }} /> : (
          <div className="form-grid">
            {LEGAL_FIELDS.map((f) => (
              <div key={f.key} className={f.span ? "span-2" : undefined}>
                <Field label={f.label} hint={f.hint}>{(id) => <input id={id} className="input" type={f.type ?? "text"} value={draft[f.key]} placeholder={f.placeholder} onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))} />}</Field>
              </div>
            ))}
          </div>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="row gap-8 no-print">
          <button className="btn primary" disabled={!dirty || busy} onClick={save}>{busy && <Spinner />}Save details</button>
          {dirty && <button className="btn ghost" onClick={() => saved && setDraft(saved)}>Discard changes</button>}
        </div>
      </div>
    </MoreRow>
  );
}

// ------------------------------------------------------------------ account recovery & keys

function AccountRecovery() {
  const { api, toast, backend } = useApp();
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!confirm) { setConfirm(true); return; }
    setBusy(true);
    try {
      const r = await api<{ factors_removed: number }>("POST", "/admin/users/reset-mfa", { email, reason });
      toast(backend.mode === "demo" ? "Demo mode: nothing to reset, but this is logged" : `Reset: ${r.factors_removed} authenticator${r.factors_removed === 1 ? "" : "s"} removed. They'll set up a new one at next sign-in.`);
      setEmail("");
      setReason("");
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't reset that account", "bad");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <MoreRow icon="smartphone" title="Lost authenticator" summary="Reset two-step verification for someone who has lost their phone" className="no-print">
      <div className="stack gap-12">
        <p className="small muted" style={{ margin: 0 }}>If someone loses the phone with their authenticator app, remove their two-step verification so they can set it up again. First confirm it's really them, for example by calling them on a number you already hold, or with their fleet owner. Never do it on the strength of an email alone.</p>
        <Field label="Their email address">{(id) => <input id={id} className="input" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setConfirm(false); }} autoComplete="off" />}</Field>
        <Field label="How you confirmed who they are" hint="Saved in the audit log">{(id) => <input id={id} className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Called back on the number in our HR system" />}</Field>
        <div><button className={`btn ${confirm ? "danger" : ""}`} disabled={busy || !email.trim() || !reason.trim()} onClick={go}>{busy && <Spinner />}{confirm ? "Confirm reset" : "Reset two-step verification"}</button></div>
      </div>
    </MoreRow>
  );
}

function KeyRotation() {
  const { api, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ tokens: number; links?: number }>("POST", "/admin/security/reencrypt");
      const links = r.links ?? 0;
      toast(`Re-encrypted with the current key: ${r.tokens} operator credential${r.tokens === 1 ? "" : "s"} and ${links} driver pass and invite link${links === 1 ? "" : "s"}`);
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't re-encrypt", "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <MoreRow icon="key" title="Encryption key" summary="Rotate it yearly, or at once if it may have leaked, then re-encrypt what's stored" className="no-print">
      <div className="stack gap-12">
        <p className="small muted" style={{ margin: 0 }}>
          Operators' credentials, driver pass links and team invite links are encrypted with <code>DATA_ENCRYPTION_KEY</code>. To rotate it (yearly, or at once if it may have leaked), put the old key in
          <code> DATA_ENCRYPTION_KEY_PREVIOUS</code>, set a new key, redeploy, then re-encrypt here. Remove the previous key afterwards. Do the same once after
          first setting a key, to encrypt credentials and links saved before it.
        </p>
        <div><button className="btn" disabled={busy} onClick={go}>{busy && <Spinner />}Re-encrypt stored credentials</button></div>
      </div>
    </MoreRow>
  );
}

const PLATFORM_ACTIONS: Record<string, string> = {
  "partner.invite": "invited an operator", "partner.connect": "connected an operator", "partner.disconnect": "disconnected an operator",
  "partner.token_regenerate": "issued a new registration token", "brand.update": "changed the branding", "legal.update": "changed company details",
  "certifications.update": "updated certificates", "compliance.tick": "ticked a checklist item", "compliance.untick": "unticked a checklist item",
  "simulator.connect": "connected the test simulator", "user.mfa_reset": "reset two-step verification for", "security.reencrypt": "re-encrypted stored credentials",
  "fleet.delete": "deleted a fleet", "account.delete": "deleted their account",
};

function PlatformAudit() {
  const { api, now } = useApp();
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    void api<AuditEntry[]>("GET", "/admin/audit?limit=100").then(setRows).catch(() => setRows([]));
  }, [api, open]);
  return (
    <MoreRow icon="history" title="Platform activity log" summary="What platform admins did, kept for 12 months" className={open ? "" : "no-print"} onToggle={(o) => { if (o) setOpen(true); }}>
      {!rows ? <div className="skeleton" style={{ height: 48 }} /> : rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>Nothing yet.</p> : (
        <ul className="list audit-list">
          {rows.map((e) => (
            <li key={e.id}>
              <span className="xs muted num nowrap">{fmtDateTime(e.at, now)}</span>
              <span className="grow small"><b>{e.actor_email ?? "Deleted account"}</b> {PLATFORM_ACTIONS[e.action] ?? e.action}{e.target ? ` ${e.target}` : ""}{e.ip ? <span className="xs muted"> · {e.ip}</span> : null}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="xs muted" style={{ margin: "8px 0 0" }}>Each fleet's own log is in its Settings → Security.</p>
    </MoreRow>
  );
}
