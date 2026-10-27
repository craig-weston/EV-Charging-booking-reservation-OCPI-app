// Error tracking without a third-party SDK: every unexpected error is logged with a short
// reference (Cloudflare Workers Logs keeps it searchable), and, when ALERT_WEBHOOK_URL is set, a
// short alert goes to Slack, Microsoft Teams, Discord or any endpoint that accepts JSON.
//
// Alerts carry no request bodies, headers or personal data: the error's name and first line, the
// method and a path with link tokens removed, and the reference to look up in the logs.

export interface AlertSink {
  env: { ALERT_WEBHOOK_URL?: string; BRAND_NAME?: string; PUBLIC_BASE_URL?: string };
  waitUntil(p: Promise<unknown>): void;
  fetch?: (req: Request) => Promise<Response>;
}

export interface ErrorReport {
  /** Where it happened: "api", "ocpi", "background", "worker", "browser". */
  where: string;
  ref: string;
  error: unknown;
  method?: string;
  path?: string;
}

const DEDUP_MS = 10 * 60_000;
const MAX_PER_HOUR = 30;
const sent = new Map<string, number>();
let hour = { start: 0, count: 0 };

/** Paths with secrets in them (pass and invite links) keep their shape but lose the token. */
export function redactPath(path: string): string {
  return path
    .replace(/^(\/api\/(?:pass|invites))\/[^/?#]+/, "$1/…")
    .replace(/#\/(pass|join)\/[^/?#]+/, "#/$1/…")
    .replace(/[?].*$/, "");
}

/** First line of the message, without anything that looks like a token or an email address. */
export function scrub(text: string, max = 300): string {
  return text
    .split("\n")[0]
    .replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "…")
    .replace(/[^\s@<>()"']+@[^\s@<>()"']+\.[a-z]{2,}/gi, "[email]")
    .slice(0, max);
}

function describe(e: unknown): { name: string; message: string } {
  if (e instanceof Error) return { name: e.name || "Error", message: scrub(e.message || "") };
  return { name: "Error", message: scrub(typeof e === "string" ? e : JSON.stringify(e) ?? String(e)) };
}

/** Logs the error and, when configured, sends a deduplicated alert. Never throws. */
export function reportError(sink: AlertSink, r: ErrorReport, now = Date.now()): { alerted: boolean } {
  const { name, message } = describe(r.error);
  const path = r.path ? redactPath(r.path) : "";
  const url = sink.env.ALERT_WEBHOOK_URL;
  if (!url) return { alerted: false };
  // Same error in the same place: one alert per 10 minutes, and at most 30 an hour per isolate.
  const key = `${r.where}|${name}|${message.replace(/\d+/g, "#")}|${path.replace(/[0-9a-f-]{8,}/gi, ":id")}`;
  if (now - (sent.get(key) ?? 0) < DEDUP_MS) return { alerted: false };
  if (now - hour.start > 3_600_000) hour = { start: now, count: 0 };
  if (hour.count >= MAX_PER_HOUR) return { alerted: false };
  sent.set(key, now);
  hour.count++;
  if (sent.size > 500) for (const k of [...sent.keys()].slice(0, 250)) sent.delete(k);

  const app = sink.env.BRAND_NAME || "Charging bookings";
  const site = sink.env.PUBLIC_BASE_URL ? ` (${sink.env.PUBLIC_BASE_URL.replace(/^https?:\/\//, "")})` : "";
  const text = `⚠️ ${app}${site}: ${name} in ${r.where}${r.method || path ? ` on ${[r.method, path].filter(Boolean).join(" ")}` : ""}: ${message || "(no message)"}. Reference ${r.ref}: search Workers Logs for it.`;
  const body = JSON.stringify({
    text, // Slack, Teams (incoming webhook / Workflows), Mattermost, Google Chat
    content: text, // Discord
    event: { where: r.where, ref: r.ref, name, message, method: r.method ?? null, path: path || null, at: new Date(now).toISOString() },
  });
  const send = (sink.fetch ?? fetch)(new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }))
    .then((res) => { if (!res.ok) console.warn(`alert webhook answered ${res.status}`); })
    .catch((e) => console.warn("alert webhook failed", e));
  sink.waitUntil(send);
  return { alerted: true };
}

/** For tests. */
export function resetAlerts() {
  sent.clear();
  hour = { start: 0, count: 0 };
}

export const shortRef = () => crypto.randomUUID().slice(0, 8);
