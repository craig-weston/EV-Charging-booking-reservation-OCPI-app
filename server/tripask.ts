// POST /api/public/trip-ask {text}: turns a trip typed in plain English ("Leeds to Southampton,
// leaving 6am with 70%") into { from, to, depart, battery_pct } with Cloudflare Workers AI (the AI
// binding, free daily allocation). Without the binding, or if the model's answer doesn't check out,
// the rule-based parser in shared/trip-text.ts answers instead. The plan itself is made in the
// browser (src/publicmap/trip.ts) from the open data and the visitor's truck.
import { parseTripText, type TripAsk } from "../shared/trip-text";

export interface AiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown> }
export interface TripAskEnv { AI?: AiBinding; TRIP_AI_MODEL?: string }

export const DEFAULT_TRIP_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const MAX_TEXT = 300;

const SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string", description: "Start town, city, port or postcode in Great Britain" },
    to: { type: "string", description: "Destination town, city, port or postcode in Great Britain" },
    depart: { type: ["string", "null"], description: "Departure time as HH:MM, 24-hour, or null" },
    battery_pct: { type: ["number", "null"], description: "Battery level at the start, percent, or null" },
  },
  required: ["from", "to"],
};
const SYSTEM = "You read requests from lorry drivers and transport planners in Great Britain and extract the trip. "
  + "Reply only with JSON matching the schema. Use place names as written, without county or postcode unless that is all they gave. "
  + "Convert times like 6am or half five in the morning to 24-hour HH:MM. If something isn't stated, use null.";

/** A model answer that is safe to use: short place names, a real time, a real percentage. */
export function cleanAsk(v: unknown): TripAsk | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const place = (x: unknown) => (typeof x === "string" && /^[\p{L}0-9 .,'&()-]{2,60}$/u.test(x.trim()) ? x.trim() : null);
  const from = place(o.from), to = place(o.to);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return null;
  const out: TripAsk = { from, to };
  if (typeof o.depart === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.depart)) out.depart = o.depart;
  const pct = typeof o.battery_pct === "string" ? Number(o.battery_pct) : o.battery_pct;
  if (typeof pct === "number" && Number.isFinite(pct) && pct >= 0 && pct <= 100) out.battery_pct = Math.round(pct);
  return out;
}

export async function askTrip(text: string, env: TripAskEnv): Promise<{ ask: TripAsk | null; by: "ai" | "rules" }> {
  const t = text.slice(0, MAX_TEXT);
  if (env.AI) {
    try {
      const res = (await env.AI.run(env.TRIP_AI_MODEL || DEFAULT_TRIP_MODEL, {
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: t }],
        response_format: { type: "json_schema", json_schema: SCHEMA },
        max_tokens: 120,
        temperature: 0,
      })) as { response?: unknown };
      let r = res?.response;
      if (typeof r === "string") { const m = r.match(/\{[\s\S]*\}/); r = m ? JSON.parse(m[0]) : null; }
      const ask = cleanAsk(r);
      if (ask) return { ask, by: "ai" };
    } catch { /* fall through to the rules */ }
  }
  return { ask: parseTripText(t), by: "rules" };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function handleTripAsk(req: Request, env: TripAskEnv): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: { message: "Use POST", code: "METHOD" } });
  let text = "";
  try { const b = (await req.json()) as { text?: unknown }; text = typeof b.text === "string" ? b.text.trim() : ""; } catch { /* empty */ }
  if (text.length < 5) return json(400, { error: { message: "Say where from and where to, for example: Leeds to Southampton, leaving 6am with 70%.", code: "BAD_REQUEST" } });
  const { ask, by } = await askTrip(text, env);
  if (!ask) return json(422, { error: { message: "I couldn't tell where from and where to. Try: Leeds to Southampton, leaving 6am with 70%.", code: "UNCLEAR" } });
  return json(200, { data: { ...ask, by } });
}
