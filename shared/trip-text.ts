// Understanding a trip typed in plain English. The server asks an AI model first (server/tripask.ts);
// this parser is the fallback, and checks what the model returns.
export interface TripAsk { from: string; to: string; depart?: string; battery_pct?: number }

/** "Leeds to Southampton, leaving 6am with 70%" → { from, to, depart: "06:00", battery_pct: 70 }. */
export function parseTripText(text: string): TripAsk | null {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/(?:from\s+)?([a-z][a-z .'-]*?)\s+(?:to|→|->)\s+([a-z][a-z .'-]*?)(?=\s*(?:,|\.|$|\s+\d|\s+(?:leaving|leave|departing|depart|at|by|with|on|battery|tomorrow|today)\b))/i);
  if (!m) return null;
  const out: TripAsk = { from: m[1].trim(), to: m[2].trim() };
  const time = t.match(/(?:leav\w*|depart\w*|at|from)\s+(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?/i) || t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (time) {
    let h = Number(time[1]); const mm = Number(time[2] ?? 0), ap = time[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    if (h < 24 && mm < 60) out.depart = `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  }
  const pct = t.match(/(\d{1,3})\s*%/);
  if (pct && Number(pct[1]) <= 100) out.battery_pct = Number(pct[1]);
  return out;
}

