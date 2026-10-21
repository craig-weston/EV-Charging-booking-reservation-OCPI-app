// Tiny hash router: "#/book?vehicle=…". Hash routing works on any static host (Cloudflare Pages,
// previews) without rewrite rules, and keeps driver-pass links shareable.
import { useEffect, useState } from "react";

export interface Route {
  path: string; // "/book"
  segments: string[]; // ["book"]
  params: URLSearchParams;
}

export function parseHash(hash = window.location.hash): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const [p, q = ""] = raw.split("?");
  const path = p.startsWith("/") ? p : `/${p}`;
  return { path, segments: path.split("/").filter(Boolean), params: new URLSearchParams(q) };
}

export function href(path: string, params?: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const qs = q.toString();
  return `#${path}${qs ? `?${qs}` : ""}`;
}

export function navigate(path: string, params?: Record<string, string | number | null | undefined>, opts: { replace?: boolean } = {}) {
  const next = href(path, params);
  if (opts.replace) {
    history.replaceState(null, "", next);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else window.location.hash = next.slice(1);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
