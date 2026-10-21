// Minimal Supabase Auth (GoTrue) client over fetch: password sign-in/up, magic links, refresh,
// and two-step verification with an authenticator app (TOTP factors, AAL2 sessions).
export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
  user: { id: string; email: string | null };
  /** Authenticator assurance level of this session (from the access token). */
  aal?: "aal1" | "aal2";
}

export interface Factor {
  id: string;
  friendly_name?: string;
  factor_type: string; // "totp"
  status: "verified" | "unverified";
  created_at: string;
}

export interface TotpEnrolment {
  id: string;
  /** SVG QR code as a data: URL, to scan with an authenticator app. */
  qr_code: string;
  /** The same secret as text, for typing in by hand. */
  secret: string;
  uri: string;
}

const KEY = "depotcharge.session";

function decodeJwt(token: string): Record<string, unknown> {
  try {
    const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(part.padEnd(part.length + ((4 - (part.length % 4)) % 4), "="));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

function fromTokens(access: string, refresh: string, expiresAt?: number, expiresIn?: number): Session {
  const claims = decodeJwt(access);
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt ?? (Number(claims.exp) || Math.floor(Date.now() / 1000) + (expiresIn ?? 3600)),
    user: { id: String(claims.sub ?? ""), email: (claims.email as string) ?? null },
    aal: claims.aal === "aal2" ? "aal2" : "aal1",
  };
}

export class AuthClient {
  session: Session | null = null;
  private listeners = new Set<(s: Session | null) => void>();
  private refreshing: Promise<Session | null> | null = null;

  constructor(private url: string, private anonKey: string) {
    this.url = url.replace(/\/+$/, "");
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) this.session = JSON.parse(raw);
    } catch { /* storage unavailable */ }
  }

  onChange(fn: (s: Session | null) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private set(s: Session | null) {
    this.session = s;
    try {
      if (s) localStorage.setItem(KEY, JSON.stringify(s));
      else localStorage.removeItem(KEY);
    } catch { /* ignore */ }
    for (const l of this.listeners) l(s);
  }

  private async call<T>(path: string, body: unknown, token?: string, method = "POST"): Promise<T> {
    const res = await fetch(`${this.url}/auth/v1/${path}`, {
      method,
      headers: { apikey: this.anonKey, "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let json: Record<string, string> = {};
    try { json = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
    if (!res.ok) throw new Error(friendlyAuthError(json.error_description || json.msg || json.message || "", res.status));
    return json as T;
  }

  /** Handles the redirect back from an email link (tokens in the URL fragment). */
  consumeRedirect(): boolean {
    const h = window.location.hash;
    if (!/access_token=/.test(h) && !/error_description=/.test(h)) return false;
    const p = new URLSearchParams(h.replace(/^#\/?/, ""));
    const err = p.get("error_description");
    if (err) {
      history.replaceState(null, "", window.location.pathname + "#/");
      throw new Error(err.replace(/\+/g, " "));
    }
    const access = p.get("access_token");
    const refresh = p.get("refresh_token");
    if (access && refresh) {
      this.set(fromTokens(access, refresh, Number(p.get("expires_at")) || undefined, Number(p.get("expires_in")) || undefined));
    }
    history.replaceState(null, "", window.location.pathname + "#/");
    return true;
  }

  async signIn(email: string, password: string) {
    const r = await this.call<{ access_token: string; refresh_token: string; expires_at?: number; expires_in?: number }>("token?grant_type=password", { email, password });
    this.set(fromTokens(r.access_token, r.refresh_token, r.expires_at, r.expires_in));
  }

  /** Returns true when an email confirmation is required before signing in. */
  async signUp(email: string, password: string): Promise<boolean> {
    const redirect = encodeURIComponent(window.location.origin + window.location.pathname);
    const r = await this.call<{ access_token?: string; refresh_token?: string; expires_in?: number }>(`signup?redirect_to=${redirect}`, { email, password });
    if (r.access_token && r.refresh_token) {
      this.set(fromTokens(r.access_token, r.refresh_token, undefined, r.expires_in));
      return false;
    }
    return true;
  }

  async sendMagicLink(email: string) {
    const redirect = encodeURIComponent(window.location.origin + window.location.pathname);
    await this.call(`otp?redirect_to=${redirect}`, { email, create_user: true });
  }

  async signOut() {
    const s = this.session;
    this.set(null);
    if (s) await this.call("logout", {}, s.access_token).catch(() => undefined);
  }

  /** Ends every session of this account, on all devices (refresh tokens revoked). */
  async signOutEverywhere() {
    const token = await this.token();
    this.set(null);
    if (token) await this.call("logout?scope=global", {}, token).catch(() => undefined);
  }

  // ---------------------------------------------------------------- two-step verification

  async factors(): Promise<Factor[]> {
    const token = await this.token();
    if (!token) return [];
    const u = await this.call<{ factors?: Factor[] }>("user", undefined, token, "GET");
    return (u.factors ?? []).filter((f) => f.factor_type === "totp");
  }

  /** Starts adding an authenticator app. Unfinished (unverified) attempts are cleared first. */
  async enrollTotp(label: string): Promise<TotpEnrolment> {
    const token = await this.token();
    if (!token) throw new Error("Please sign in again");
    for (const f of await this.factors()) if (f.status === "unverified") await this.call(`factors/${f.id}`, undefined, token, "DELETE").catch(() => undefined);
    const r = await this.call<{ id: string; totp: { qr_code: string; secret: string; uri: string } }>("factors", { factor_type: "totp", friendly_name: label.slice(0, 60), issuer: label.slice(0, 60) }, token);
    return { id: r.id, qr_code: r.totp.qr_code, secret: r.totp.secret, uri: r.totp.uri };
  }

  /** Checks a 6-digit code; on success the session is upgraded to AAL2. */
  async verifyTotp(factorId: string, code: string): Promise<void> {
    const token = await this.token();
    if (!token) throw new Error("Please sign in again");
    const ch = await this.call<{ id: string }>(`factors/${factorId}/challenge`, {}, token);
    const r = await this.call<{ access_token: string; refresh_token: string; expires_at?: number; expires_in?: number }>(`factors/${factorId}/verify`, { challenge_id: ch.id, code: code.replace(/\s/g, "") }, token);
    this.set(fromTokens(r.access_token, r.refresh_token, r.expires_at, r.expires_in));
  }

  /** Removes an authenticator (needs an AAL2 session), then refreshes the session. */
  async unenroll(factorId: string): Promise<void> {
    const token = await this.token();
    if (!token) throw new Error("Please sign in again");
    await this.call(`factors/${factorId}`, undefined, token, "DELETE");
    await this.refresh();
  }

  /** A valid access token, refreshed when it expires within a minute. */
  async token(): Promise<string | null> {
    const s = this.session;
    if (!s) return null;
    if (s.expires_at - 60 > Date.now() / 1000) return s.access_token;
    const fresh = await this.refresh();
    return fresh?.access_token ?? null;
  }

  async refresh(): Promise<Session | null> {
    if (!this.session) return null;
    this.refreshing ??= (async () => {
      try {
        const r = await this.call<{ access_token: string; refresh_token: string; expires_at?: number; expires_in?: number }>("token?grant_type=refresh_token", { refresh_token: this.session!.refresh_token });
        const s = fromTokens(r.access_token, r.refresh_token, r.expires_at, r.expires_in);
        this.set(s);
        return s;
      } catch {
        this.set(null);
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

/** Supabase Auth messages, made a little friendlier. */
function friendlyAuthError(msg: string, status: number): string {
  if (status === 429 || /rate limit|too many/i.test(msg)) return "Too many attempts. Wait a few minutes and try again.";
  if (/invalid login credentials/i.test(msg)) return "That email and password don't match an account.";
  if (/invalid totp|invalid code|code.*(expired|invalid)/i.test(msg)) return "That code didn't work. Check the time on your phone is right and try the newest code.";
  if (/aal2 required|insufficient_aal/i.test(msg)) return "Confirm with your authenticator app first.";
  if (/weak|pwned|leaked/i.test(msg)) return "Choose a different password: this one appears in known data breaches or is too easy to guess.";
  return msg || "Sign-in service error";
}
