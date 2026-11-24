// Understanding a trip typed in plain English. The server asks an AI model first (server/tripask.ts);
// this parser is the fallback, and checks what the model returns.
export interface TripAsk { from: string; to: string; depart?: string; battery_pct?: number }

/** "Leeds to Southampton, leaving 6am with 70%" → { from, to, depart: "06:00", battery_pct: 70 }. */
const FILLER = new Set(["i", "i'm", "im", "we", "we're", "were", "need", "needs", "want", "wants", "have", "has", "got", "to", "get", "go", "going", "drive", "driving", "run", "running", "head", "heading", "travel", "travelling", "a", "the", "load", "delivery", "trip", "truck", "lorry", "please", "can", "you", "plan", "route", "me", "my", "our"]);
const tidy = (place: string) => {
  const words = place.replace(/[^\p{L}0-9 .'-]/gu, " ").trim().split(/\s+/);
  while (words.length > 1 && FILLER.has(words[0].toLowerCase())) words.shift();
  return words.slice(-4).join(" ");
};

/** "Leeds to Southampton, leaving 6am with 70%" → { from, to, depart: "06:00", battery_pct: 70 }. */
export function parseTripText(text: string): TripAsk | null {
  const t = text.replace(/\s+/g, " ").trim();
  const end = String.raw`(?=\s*(?:,|\.|;|$|\s+\d|\s+(?:leaving|leave|setting|set|departing|depart|at|by|with|on|battery|tomorrow|today|this|for|about|around)\b))`;
  const via = String.raw`\s+(?:(?:down|up|over|across)\s+)?(?:to|→|->)\s+`;
  const m = t.match(new RegExp(String.raw`\bfrom\s+([\p{L}][\p{L} .'-]*?)` + via + String.raw`([\p{L}][\p{L} .'-]*?)` + end, "iu"))
    ?? t.match(new RegExp(String.raw`([\p{L}][\p{L} .'-]*?)` + via + String.raw`([\p{L}][\p{L} .'-]*?)` + end, "iu"));
  if (!m) return null;
  const from = tidy(m[1]), to = tidy(m[2]);
  if (!from || !to || FILLER.has(from.toLowerCase())) return null;
  const out: TripAsk = { from, to };
  const half = t.match(/half\s+(past\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(am|pm|in the morning|in the evening|at night)?/i);
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const time = t.match(/(?:leav\w*|depart\w*|set(?:ting)? off|at)\s+(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?/i) || t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  let h: number | null = null, mm = 0, ap: string | undefined;
  if (half) { h = Number(half[2]) || words[half[2].toLowerCase()]; mm = 30; ap = /pm|evening|night/i.test(half[3] ?? "") ? "pm" : /am|morning/i.test(half[3] ?? "") ? "am" : undefined; }
  else if (time) { h = Number(time[1]); mm = Number(time[2] ?? 0); ap = time[3]?.toLowerCase(); }
  if (h != null) {
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    if (h < 24 && mm < 60) out.depart = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  const pct = t.match(/(\d{1,3})\s*(?:%|per ?cent)/i);
  if (pct && Number(pct[1]) <= 100) out.battery_pct = Number(pct[1]);
  return out;
}

