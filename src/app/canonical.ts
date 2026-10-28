// Which address the app should be on. Kept apart from main.tsx so it can be tested.
/** The platform's own origin when this page was opened on its production workers.dev address
 *  (e.g. depotcharge.example.workers.dev → depotcharge.example.com). Preview addresses
 *  (<version>-depotcharge.….workers.dev) and any other host stay where they are. */
export function canonicalOrigin(loc: Pick<Location, "hostname" | "origin">, versionsUrl: string): string | null {
  let base: URL;
  try { base = new URL(versionsUrl); } catch { return null; }
  if (base.protocol !== "https:" || base.origin === loc.origin) return null;
  if (!loc.hostname.endsWith(".workers.dev") || base.hostname.endsWith(".workers.dev")) return null;
  return loc.hostname.split(".")[0] === base.hostname.split(".")[0] ? base.origin : null;
}
