// Number-plate lookup (shared/plates.ts) from DVLA's Vehicle Enquiry Service: free, with a key from
// DVLA's developer portal (DVLA_API_KEY). No account is needed to ask (the public map uses it), so it
// is rate-limited per visitor (server/live.ts) and answers are kept a day in memory to spare DVLA's
// quota. Plates aren't stored or logged here.
//
//   POST /api/public/plate   { "plate": "PN74 EVH" }   → { data: PlateDetails }
//
// POST, so plates stay out of URLs and logs. Without a key: 503, and the map and the vehicle form
// carry on by hand.
import type { MarketDeps } from "./market";
import { fromDvla, isUkPlate, type PlateDetails } from "../shared/plates";
import { normalizePlate } from "../shared/util";

const DVLA = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";
const KEEP_MS = 24 * 3_600_000;
const TIMEOUT_MS = 10_000;
const memory = new Map<string, { at: number; value: PlateDetails | null }>();

export class PlateError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function lookupPlate(d: Pick<MarketDeps, "now" | "transport"> & { env?: { DVLA_API_KEY?: string } }, raw: unknown): Promise<PlateDetails> {
  if (typeof raw !== "string" || !isUkPlate(raw)) throw new PlateError("That doesn't look like a UK number plate", 400);
  const plate = normalizePlate(raw);
  const now = d.now().getTime();
  const hit = memory.get(plate);
  if (hit && now - hit.at < KEEP_MS) {
    if (!hit.value) throw new PlateError("DVLA has no vehicle with that number plate", 404);
    return hit.value;
  }
  const key = d.env?.DVLA_API_KEY?.trim();
  if (!key) throw new PlateError("Number-plate lookup isn't set up here yet", 503);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await d.transport(new Request(DVLA, { method: "POST", signal: ctl.signal, headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ registrationNumber: plate }) }));
  } catch {
    throw new PlateError("DVLA's lookup didn't answer. Try again in a moment", 504);
  } finally { clearTimeout(timer); }
  const remember = (value: PlateDetails | null) => { memory.set(plate, { at: now, value }); if (memory.size > 2000) memory.delete(memory.keys().next().value!); };
  if (res.status === 404) { remember(null); throw new PlateError("DVLA has no vehicle with that number plate", 404); }
  if (res.status === 400) throw new PlateError("That doesn't look like a UK number plate", 400);
  if (res.status === 401 || res.status === 403) throw new PlateError("Number-plate lookup isn't set up here yet", 503);
  if (res.status === 429) throw new PlateError("Number-plate lookup is busy. Try again in a minute", 503);
  const details = res.ok ? fromDvla(await res.json().catch(() => null)) : null;
  if (!details) throw new PlateError("DVLA's lookup isn't available right now", 502);
  remember(details);
  return details;
}

/** POST /api/public/plate */
export async function handlePlate(req: Request, d: Parameters<typeof lookupPlate>[0]): Promise<Response> {
  const json = (data: unknown, status: number) => Response.json(status < 400 ? { data } : { error: data }, { status, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return json({ message: "Use POST" }, 405);
  const body = (await req.json().catch(() => null)) as { plate?: unknown } | null;
  try { return json(await lookupPlate(d, body?.plate), 200); }
  catch (e) { if (e instanceof PlateError) return json({ message: e.message }, e.status); throw e; }
}
