// Public charging sites from open data (shared/opendata), loaded once per visit from this
// deployment's /api/public/sites. Without a server (static preview, tests) there are none.
import { useEffect, useState } from "react";
import { cleanOpenSites, type OpenSitesFile } from "../../shared/opendata/sites";

let loading: Promise<OpenSitesFile | null> | null = null;

export function loadOpenSites(origin: string): Promise<OpenSitesFile | null> {
  loading ??= fetch(`${origin.replace(/\/+$/, "")}/api/public/sites`, { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { data?: unknown } | null) => cleanOpenSites(j?.data))
    .catch(() => null);
  return loading;
}

export function useOpenSites(origin: string | undefined): OpenSitesFile | null {
  const [file, setFile] = useState<OpenSitesFile | null>(null);
  useEffect(() => {
    if (!origin) return;
    let live = true;
    void loadOpenSites(origin).then((f) => { if (live) setFile(f); });
    return () => { live = false; };
  }, [origin]);
  return file;
}
