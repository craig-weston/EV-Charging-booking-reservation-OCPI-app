// POST /api/public/trip-ask {text}: turns a trip typed in plain English ("Leeds to Southampton,
// leaving 6am with 70%") into { from, to, depart, battery_pct } with Cloudflare Workers AI (the AI
// binding, free daily allocation). Without the binding, or if the model's answer doesn't check out,
// the rule-based parser in shared/trip-text.ts answers instead. The plan itself is made in the
// browser (src/publicmap/trip.ts) from the open data and the visitor's truck.
import { parseTripText, type TripAsk } from "../shared/trip-text";

export interface AiBinding { run(model: string, input: Record<string, unknown>): Promise<unknown> }
export interface TripAskEnv { AI?: AiBinding; TRIP_AI_MODEL?: string }

/** Tried in order: models get retired (llama-3.1-8b-instruct was, in May 2026), so there's a spare. */
export const TRIP_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/zai-org/glm-4.7-flash"];
const MAX_TEXT = 300;

const SCHEMA = {
  type: "object",
  properties: {
    from: { type: "string", description: "Start town, city, port or postcode in Great Britain" },
    to: { type: "string", description: "Destination town, city, port or postcode in Great Britain" },
    depart: { type: "string", description: "Departure time as HH:MM, 24-hour, or an empty string" },
    battery_pct: { type: "number", description: "Battery level at the start, percent, or -1 if not given" },
  },
  required: ["from", "to"],
};
const SYSTEM = "You read requests from lorry drivers and transport planners in Great Britain and extract the trip. "
  + "Reply only with JSON matching the schema. Use place names as written, without county or postcode unless that is all they gave. "
  + "Convert times like 6am or half five in the morning to 24-hour HH:MM. If the time isn't stated use an empty string; if the battery isn't stated use -1. "
  + "Example: {\"from\":\"Leeds\",\"to\":\"Southampton\",\"depart\":\"06:30\",\"battery_pct\":70}";

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

/** The model's answer as an object, whether it came back as an object or as text around some JSON. */
function answerOf(res: unknown): unknown {
  const o = res as { response?: unknown; choices?: { message?: { content?: unknown } }[]; result?: { response?: unknown } } | null;
  let r = o?.response ?? o?.choices?.[0]?.message?.content ?? o?.result?.response;
  if (typeof r === "string") { const m = r.match(/\{[\s\S]*\}/); try { r = m ? JSON.parse(m[0]) : null; } catch { r = null; } }
  return r;
}

export async function askTrip(text: string, env: TripAskEnv): Promise<{ ask: TripAsk | null; by: "ai" | "rules"; ai?: string }> {
  const t = text.slice(0, MAX_TEXT);
  let ai = "unavailable";
  if (env.AI) {
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: t }];
    const models = [...new Set([env.TRIP_AI_MODEL, ...TRIP_MODELS].filter((m): m is string => !!m))];
    for (const model of models) {
      // JSON mode first; some models or moments refuse it, so then plain text with the same instructions.
      for (const extra of [{ response_format: { type: "json_schema", json_schema: SCHEMA } }, {}]) {
        try {
          const ask = cleanAsk(answerOf(await env.AI.run(model, { messages, max_tokens: 300, temperature: 0, ...extra })));
          if (ask) return { ask, by: "ai" };
          ai = "unclear";
        } catch (e) {
          ai = "error";
          console.warn(`trip-ask: Workers AI ${model} failed`, String(e).slice(0, 200));
          if (/deprecat|not found|5028|5007/i.test(String(e))) break; // this model is gone: try the next
        }
      }
    }
  }
  return { ask: parseTripText(t), by: "rules", ai };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function handleTripAsk(req: Request, env: TripAskEnv): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: { message: "Use POST", code: "METHOD" } });
  let text = "";
  try { const b = (await req.json()) as { text?: unknown }; text = typeof b.text === "string" ? b.text.trim() : ""; } catch { /* empty */ }
  if (text.length < 5) return json(400, { error: { message: "Say where from and where to, for example: Leeds to Southampton, leaving 6am with 70%.", code: "BAD_REQUEST" } });
  const { ask, by, ai } = await askTrip(text, env);
  if (!ask) return json(422, { error: { message: "I couldn't tell where from and where to. Try: Leeds to Southampton, leaving 6am with 70%.", code: "UNCLEAR" } });
  return json(200, { data: { ...ask, by, ...(by === "rules" && ai ? { ai } : {}) } });
}
