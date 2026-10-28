// The web app talks to one JSON API (/api/*). In live mode that is the Cloudflare Pages Function;
// in demo mode the very same server code runs inside the browser (see demo.ts).
import type { AppConfig, InvitePreview } from "../../shared/model";
import { DEFAULT_BRAND } from "../../shared/model";
import { AuthClient } from "./auth";

export class ApiFailure extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export interface Backend {
  mode: "live" | "demo";
  config: AppConfig;
  auth: AuthClient | null;
  api<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Notifies of server-side changes (demo only — live mode polls). */
  onChange?(cb: () => void): () => void;
  reset?(): Promise<void>;
  /** The public "Try the demo" on a live deployment: sample data in this browser, no account. */
  publicDemo?: { exit(): void; signUp(): void };
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: { data?: T; error?: { message: string; code?: string } } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
  if (!res.ok) throw new ApiFailure(res.status, json.error?.message ?? `Request failed (${res.status})`, json.error?.code);
  return json.data as T;
}

/** Public invite preview for the sign-in screen (no session yet). */
export async function fetchInvitePreview(token: string): Promise<InvitePreview | null> {
  try {
    const res = await fetch(`/api/invites/${encodeURIComponent(token)}`, { headers: { Accept: "application/json" } });
    return await parse<InvitePreview>(res);
  } catch {
    return null;
  }
}

/** Fetches /api/config; resolves null when there is no API (static preview, file://). */
export async function fetchConfig(): Promise<AppConfig | null> {
  if (!/^https?:$/.test(window.location.protocol)) return null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4000);
    const res = await fetch("/api/config", { signal: ac.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    if (!res.ok || !(res.headers.get("Content-Type") ?? "").includes("json")) return null;
    const cfg = await parse<AppConfig>(res);
    return cfg ? { ...cfg, brand: { ...DEFAULT_BRAND, ...cfg.brand } } : null;
  } catch {
    return null;
  }
}

export function createLiveBackend(config: AppConfig): Backend {
  const auth = new AuthClient(config.supabase_url!, config.supabase_anon_key!);
  const call = async <T>(method: string, path: string, body: unknown, retry: boolean): Promise<T> => {
    const token = await auth.token();
    const res = await fetch(`/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retry && auth.session) {
      // A missing second factor isn't fixed by refreshing the session; an expired token is.
      const code = await res.clone().json().then((j: { error?: { code?: string } }) => j.error?.code, () => undefined);
      if (code !== "MFA_CHALLENGE") {
        await auth.refresh();
        return call<T>(method, path, body, false);
      }
    }
    return parse<T>(res);
  };
  return { mode: "live", config, auth, api: (m, p, b) => call(m, p, b, true) };
}
