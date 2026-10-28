import { useEffect, useMemo, useState } from "react";
import type { AppConfig, InvitePreview } from "../../shared/model";
import type { AuthClient } from "../app/auth";
import { useApp } from "../app/state";
import { ApiFailure, fetchInvitePreview } from "../app/backend";
import { href } from "../app/router";
import { passwordProblems } from "../../shared/password";
import { BrandMark, Field, Icon, Spinner } from "../ui/ui";
import { ChargeStory } from "../components/art/ChargeStory";
import { LegalFooter } from "../legal/LegalPage";
import { CertificationBadges } from "../legal/documents";

/** The sign-in and set-up screens show how a booked truck charges, beside the form. */
function AuthArt() {
  return (
    <aside className="auth-art" aria-label="How charging works">
      <h2>Book the bay. The truck does the rest.</h2>
      <ChargeStory audience="planner" />
    </aside>
  );
}

export const PENDING_INVITE_KEY = "depotcharge.invite";

export function SignIn({ auth, config, inviteToken }: { auth: AuthClient; config: AppConfig; inviteToken?: string }) {
  const brand = config.brand;
  const [mode, setMode] = useState<"signin" | "signup" | "link">(inviteToken || window.location.hash.startsWith("#/signup") ? "signup" : "signin");
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  useEffect(() => {
    if (!inviteToken) return;
    // Email confirmation links land on the home page, so remember the invite until sign-in completes.
    try { localStorage.setItem(PENDING_INVITE_KEY, inviteToken); } catch { /* storage unavailable */ }
    void fetchInvitePreview(inviteToken).then((p) => { setInvite(p); if (p?.email) setEmail((e) => e || p.email!); });
  }, [inviteToken]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const minLength = config.security?.password_min_length ?? 12;
  // NCSC-style rules: long, not a known common password, not your email. No forced symbols.
  const problems = useMemo(() => (mode === "signup" ? passwordProblems(password, { min: minLength, email, product: brand.name }) : []), [mode, password, minLength, email, brand.name]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === "signin") await auth.signIn(email, password);
      else if (mode === "signup") {
        const confirm = await auth.signUp(email, password);
        if (confirm) setNotice(`We've sent a confirmation link to ${email}. Open it on this device to finish.`);
      } else {
        await auth.sendMagicLink(email);
        setNotice(`Check ${email} for a sign-in link.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap split">
      <form className="auth-card" onSubmit={submit}>
        <BrandMark brand={brand} />
        {invite && <div className="invite-note"><b>You're invited to join {invite.fleet_name}</b>{mode === "signup" ? "Create an account to accept, or sign in if you have one." : "Sign in to accept the invite."}</div>}
        <div>
          <h1 style={{ fontSize: "var(--fs-xl)" }}>{mode === "signup" ? "Create your account" : "Sign in"}</h1>
          <p className="small muted" style={{ marginTop: 4 }}>Book charging slots for your trucks at depots and hubs.</p>
        </div>
        <Field label="Work email">{(id) => <input id={id} className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        {mode !== "link" && (
          <Field label="Password" hint={mode === "signup" ? `At least ${minLength} characters. Three or four random words work well, or use a password manager.` : undefined}>
            {(id) => <input id={id} className="input" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} required minLength={mode === "signup" ? minLength : undefined} maxLength={mode === "signup" ? 72 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} aria-describedby={mode === "signup" ? "pw-rules" : undefined} />}
          </Field>
        )}
        {mode === "signup" && password.length > 0 && (
          <ul className="pw-rules" id="pw-rules" aria-live="polite">
            {problems.length === 0
              ? <li className="ok"><Icon name="check" size="sm" />Good password</li>
              : problems.map((p) => <li key={p}><Icon name="info" size="sm" />{p}</li>)}
          </ul>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
        {notice && <div className="small" role="status">{notice}</div>}
        <button className="btn primary lg block" disabled={busy || (mode === "signup" && problems.length > 0)}>{busy && <Spinner />}{mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : "Email me a sign-in link"}</button>
        <div className="row gap-8 wrap small">
          {mode !== "signin" && <button type="button" className="btn ghost sm" onClick={() => setMode("signin")}>I have a password</button>}
          {mode !== "link" && <button type="button" className="btn ghost sm" onClick={() => setMode("link")}>Email me a link instead</button>}
          {mode !== "signup" && <button type="button" className="btn ghost sm" onClick={() => setMode("signup")}>Create an account</button>}
        </div>
        {mode === "signup" && (
          <p className="xs muted">
            {brand.name} is a service for businesses. By creating an account you agree to use it in line with the <a href={href("/legal/terms")}>terms of service</a>.
            The <a href={href("/legal/privacy")}>privacy notice</a> explains how your data is used.
          </p>
        )}
        {!inviteToken && (
          <a className="try-demo" href="#/demo" onClick={(e) => { e.preventDefault(); window.location.hash = "#/demo"; window.location.reload(); }}>
            <span className="try-demo-icon" aria-hidden="true"><Icon name="play" size="sm" /></span>
            <span className="grow"><b>Not ready to sign up? Try the demo</b><span className="xs muted">Sample trucks, bookings and simulated operators. Nothing is real and nothing is saved to an account.</span></span>
            <Icon name="chevronRight" size="sm" />
          </a>
        )}
        {config.certifications?.length > 0 && <CertificationBadges list={config.certifications} compact />}
        <LegalFooter config={config} compact />
      </form>
      <AuthArt />
    </div>
  );
}

export function Onboarding() {
  const { api, refreshMe, brand, toast } = useApp();
  const [name, setName] = useState("");
  const [sample, setSample] = useState(false);
  const [accept, setAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accept) return;
    setBusy(true);
    try {
      await api("POST", "/fleets", { name, sample, accept_terms: true });
      await refreshMe();
    } catch (err) {
      toast(err instanceof ApiFailure ? err.message : "Couldn't create the fleet", "bad");
      setBusy(false);
    }
  };
  return (
    <div className="auth-wrap split">
      <form className="auth-card" onSubmit={submit}>
        <BrandMark brand={brand} />
        <div>
          <h1 style={{ fontSize: "var(--fs-xl)" }}>Set up your fleet</h1>
          <p className="small muted" style={{ marginTop: 4 }}>You'll add trucks next. You can invite colleagues from Settings, Team.</p>
        </div>
        <Field label="Company or fleet name">{(id) => <input id={id} className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Ridgeway Logistics" autoFocus />}</Field>
        <label className="check"><input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} /><span>Add five sample trucks so I can try booking straight away</span></label>
        <label className="check">
          <input type="checkbox" checked={accept} onChange={(e) => setAccept(e.target.checked)} required />
          <span>I accept the <a href={href("/legal/terms")} target="_blank" rel="noreferrer">terms of service</a> and <a href={href("/legal/dpa")} target="_blank" rel="noreferrer">data processing terms</a> on behalf of {name.trim() || "my organisation"}, and I'm authorised to do so.</span>
        </label>
        <button className="btn primary lg block" disabled={busy || !name.trim() || !accept}>{busy && <Spinner />}Create fleet</button>
      </form>
      <AuthArt />
    </div>
  );
}
