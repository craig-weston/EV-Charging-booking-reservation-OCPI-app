// Reports unexpected errors in the browser to /api/client-errors, so they show up in the server
// logs and alerts (server/alerts.ts) instead of only in someone's console. Sends the error's name
// and message, the page (link tokens removed) and the app version: nothing typed into the app.

const MAX_PER_PAGE = 5;
let count = 0;
const seen = new Set<string>();
let enabled = false;

/** App build, from the content-hashed script name (e.g. "app-RSMLAZZ6"). */
function release(): string {
  const src = document.querySelector<HTMLScriptElement>('script[src*="/assets/app-"]')?.src ?? "";
  return src.match(/app-[A-Za-z0-9]+/)?.[0] ?? "dev";
}

function page(): string {
  return (location.pathname + location.hash).replace(/#\/(pass|join)\/[^/?]+/, "#/$1/…").replace(/\?.*$/, "");
}

export function reportClientError(error: unknown, source = "") {
  if (!enabled || count >= MAX_PER_PAGE) return;
  const e = error instanceof Error ? error : new Error(typeof error === "string" ? error : "Non-error thrown");
  const key = `${e.name}:${e.message}`;
  // Ignore noise that isn't ours: cross-origin "Script error." and extension frames.
  if (seen.has(key) || e.message === "Script error." || /(chrome|moz|safari)-extension:/.test(source + (e.stack ?? ""))) return;
  seen.add(key);
  count++;
  const frame = (e.stack ?? "").split("\n").find((l) => l.includes("/assets/")) ?? source;
  void fetch("/api/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: e.name, message: e.message.slice(0, 500), source: frame.trim().slice(0, 200), page: page(), release: release() }),
    keepalive: true,
  }).catch(() => undefined);
}

/** Call once, in live mode (the demo has no server to report to). */
export function installErrorReporting() {
  enabled = true;
  window.addEventListener("error", (ev) => reportClientError(ev.error ?? ev.message, ev.filename ?? ""));
  window.addEventListener("unhandledrejection", (ev) => reportClientError(ev.reason, "unhandledrejection"));
}
