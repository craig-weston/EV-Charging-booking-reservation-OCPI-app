// Battery levels from the trucks (shared/energy/telematics.ts): stores readings, and polls the truck
// makers' rFMS APIs every 15 minutes for fleets that have set one up. See docs/telematics.md.
import type { Ctx } from "./context";
import type { FleetEnergyRow, Vehicle } from "../shared/model";
import { mergeTelemetry, parseRfmsStatuses, plateKey, type RfmsSettings, type Telemetry } from "../shared/energy/telematics";
import { energyRow } from "./depot";
import { openSecret } from "./security";
import { iso } from "../shared/util";

const TIMEOUT_MS = 10_000;
const ACCEPT_V4 = "application/json; rfms=vehiclestatuses.v4.0";
const ACCEPT_V21 = "application/vnd.fmsstandard.com.vehiclestatuses.v2.1+json; UTF-8";

/** Adds readings (by vehicle id) to the fleet's latest-reading store. */
export async function recordTelemetry(ctx: Ctx, fleetId: string, readings: Record<string, Telemetry>): Promise<void> {
  if (!Object.keys(readings).length) return;
  const row = await energyRow(ctx, fleetId);
  row.state = { ...(row.state ?? { dispatch: {} }), dispatch: row.state?.dispatch ?? {}, telemetry: mergeTelemetry(row.state?.telemetry, readings) };
  row.updated_at = iso(ctx.now());
  await ctx.store.saveEnergy(row);
}

/** Which vehicle a pushed reading is for: its id, its plate, or its VIN (from the rFMS settings). */
export function matchVehicle(vehicles: Vehicle[], vinToId: Record<string, string>, ref: { vehicle_id?: unknown; plate?: unknown; vin?: unknown }): Vehicle | null {
  const id = typeof ref.vehicle_id === "string" ? ref.vehicle_id : "";
  if (id) return vehicles.find((v) => v.id === id) ?? null;
  const vin = typeof ref.vin === "string" ? ref.vin.toUpperCase().trim() : "";
  if (vin && vinToId[vin]) return vehicles.find((v) => v.id === vinToId[vin]) ?? null;
  const plate = typeof ref.plate === "string" ? plateKey(ref.plate) : "";
  return plate ? vehicles.find((v) => plateKey(v.plate) === plate) ?? null : null;
}

async function call(ctx: Ctx, req: Request): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await ctx.transport(new Request(req, { signal: ctl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function authHeader(ctx: Ctx, s: RfmsSettings, secret: string): Promise<string> {
  if (s.auth === "basic") return `Basic ${btoa(`${s.username}:${secret}`)}`;
  if (!s.token_url) throw new Error("Add the token address for OAuth2");
  const res = await call(ctx, new Request(s.token_url, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: s.username, client_secret: secret }).toString(),
  }));
  if (!res.ok) throw new Error(`The token address answered ${res.status}`);
  const j = (await res.json().catch(() => ({}))) as { access_token?: string };
  if (!j.access_token) throw new Error("No access token in the answer");
  return `Bearer ${j.access_token}`;
}

/** Latest vehicle statuses from an rFMS API: readings by VIN, and every VIN seen (for set-up). */
export async function fetchRfms(ctx: Ctx, s: RfmsSettings, secret: string): Promise<{ readings: { vin: string; t: Telemetry }[]; vins: string[] }> {
  const auth = await authHeader(ctx, s, secret);
  const seen = new Set<string>();
  const readings: { vin: string; t: Telemetry }[] = [];
  let url: string | null = `${s.base_url}/vehiclestatuses?latestOnly=true&contentFilter=SNAPSHOT`;
  for (let page = 0; url && page < 10; page++) {
    let res = await call(ctx, new Request(url, { headers: { Authorization: auth, Accept: ACCEPT_V4 } }));
    if (res.status === 406 || res.status === 415) res = await call(ctx, new Request(url, { headers: { Authorization: auth, Accept: ACCEPT_V21 } }));
    if (res.status === 401 || res.status === 403) throw new Error("The truck data service didn't accept the user name and password");
    if (!res.ok) throw new Error(`The truck data service answered ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const list = ((body.vehicleStatusResponse as Record<string, unknown> | undefined)?.vehicleStatuses ?? []) as { vin?: string }[];
    for (const v of Array.isArray(list) ? list : []) if (v?.vin) seen.add(String(v.vin).toUpperCase());
    readings.push(...parseRfmsStatuses(body));
    const next = body.moreDataAvailable === true && typeof body.moreDataAvailableLink === "string" ? body.moreDataAvailableLink : null;
    // Follow the next-page link only on the same server, so the sign-in never goes anywhere else.
    const nextUrl = next ? new URL(next, s.base_url + "/") : null;
    url = nextUrl && nextUrl.origin === new URL(s.base_url).origin ? nextUrl.toString() : null;
  }
  return { readings, vins: [...seen] };
}

async function rfmsSecret(ctx: Ctx, row: FleetEnergyRow): Promise<string | null> {
  return row.secrets?.telematics ? openSecret(row.secrets.telematics, ctx.env.DATA_ENCRYPTION_KEY, ctx.env.DATA_ENCRYPTION_KEY_PREVIOUS) : null;
}

/** Polls one fleet's rFMS API and stores what it got. Returns how many trucks reported. */
export async function pollFleet(ctx: Ctx, row: FleetEnergyRow): Promise<{ trucks: number; unmatched: string[] }> {
  const s = row.config.telematics?.kind === "rfms" ? row.config.telematics.rfms : undefined;
  if (!s) return { trucks: 0, unmatched: [] };
  const secret = await rfmsSecret(ctx, row);
  if (!secret) throw new Error("Add the password or client secret first");
  const { readings, vins } = await fetchRfms(ctx, s, secret);
  const idByVin = Object.fromEntries(Object.entries(s.vins).map(([id, vin]) => [vin, id]));
  const byId: Record<string, Telemetry> = {};
  for (const r of readings) if (idByVin[r.vin]) byId[idByVin[r.vin]] = r.t;
  await recordTelemetry(ctx, row.fleet_id, byId);
  return { trucks: Object.keys(byId).length, unmatched: vins.filter((v) => !idByVin[v]) };
}

/** Every 15 minutes (worker cron). */
export async function runTelematics(ctx: Ctx): Promise<number> {
  let n = 0;
  for (const row of await ctx.store.listEnergy()) {
    if (row.config.telematics?.kind !== "rfms") continue;
    try {
      n += (await pollFleet(ctx, row)).trucks;
    } catch (e) {
      console.warn(`telematics: fleet ${row.fleet_id}: ${(e as Error).message}`);
    }
  }
  return n;
}
