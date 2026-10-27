// Automatic driver messages: a text or WhatsApp with the pass link when a booking is confirmed,
// changed or cancelled. Sent through Twilio's REST API (web-standard fetch, no SDK).
//
// Each booking remembers what the driver was last told (`driver_notified`), so a repeated push from
// the operator never sends the same message twice, and a cancellation only goes to a driver who
// was told about the booking in the first place.
import type { BookingRow, Driver, Fleet, NotifyChannel } from "../shared/model";
import type { Location } from "../shared/ocpi/types";
import { fmtDay, fmtRange, DEFAULT_TZ } from "../src/app/format";
import type { Ctx, Env } from "./context";

export type NotifyKind = "booked" | "changed" | "cancelled";

/** Which channels this deployment can send on (shown in Settings). */
export function notifyChannels(env: Env, mode: Ctx["mode"]): { sms: boolean; whatsapp: boolean } {
  // The browser demo "sends" on both channels and records the message on the booking instead.
  if (mode === "demo") return { sms: true, whatsapp: true };
  const twilio = !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  return { sms: twilio && !!env.TWILIO_FROM, whatsapp: twilio && !!env.TWILIO_WHATSAPP_FROM };
}

/** UK-first phone normalisation to E.164. Returns null for anything that isn't a plausible number. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("+44")) s = "+44" + s.slice(3).replace(/^0/, "");
  else if (s.startsWith("0")) s = "+44" + s.slice(1);
  else if (!s.startsWith("+")) return null;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

const signature = (row: BookingRow) => `R|${row.driver_id}|${row.start_at}|${row.end_at}|${row.pass_token}`;

/** Decide whether this booking's current state needs a message, and to whom. */
export function planNotification(row: BookingRow): { kind: NotifyKind; driverId: string; sig: string } | null {
  const last = row.driver_notified ?? null;
  if (row.reservation_status === "RESERVED" && row.driver_id) {
    const sig = signature(row);
    if (sig === last) return null;
    // Same driver already told about this booking → it's a change; otherwise a fresh confirmation.
    const sameDriver = last?.startsWith(`R|${row.driver_id}|`);
    return { kind: sameDriver ? "changed" : "booked", driverId: row.driver_id, sig };
  }
  if (row.reservation_status === "CANCELED" && last?.startsWith("R|")) {
    return { kind: "cancelled", driverId: last.split("|")[1], sig: "C" };
  }
  return null;
}

export function messageText(kind: NotifyKind, p: { site: string; start_at: string; end_at: string; plate: string; url: string; tz: string; now: Date; deskPhone?: string | null }): string {
  const when = `${fmtDay(p.start_at, p.now, p.tz)} ${fmtRange(p.start_at, p.end_at, p.tz)}`;
  if (kind === "cancelled") {
    return `Charging booking cancelled: ${p.site}, ${when} for ${p.plate}. Don't go to this site for this slot.${p.deskPhone ? ` Questions: ${p.deskPhone}` : ""}`;
  }
  const lead = kind === "changed" ? "Charging booking changed" : "Charging booked";
  return `${lead}: ${p.site}, ${when} for ${p.plate}. Just drive in and plug in. Details: ${p.url}`;
}

export const passLink = (ctx: Ctx, token: string) => `${ctx.baseUrl}/#/pass/${token}`;

/**
 * Send the driver a message if the booking's state calls for one. Never throws: the outcome is
 * recorded on the booking's timeline instead. Call it in the background (ctx.waitUntil).
 */
export async function notifyDriver(ctx: Ctx, bookingId: string): Promise<void> {
  const row = await ctx.store.getBooking(bookingId);
  if (!row) return;
  const plan = planNotification(row);
  if (!plan) return;
  const fleet: Fleet | null = await ctx.store.getFleet(row.fleet_id);
  const channel: NotifyChannel = fleet?.notify_drivers ?? "off";
  if (!fleet || channel === "off" || !notifyChannels(ctx.env, ctx.mode)[channel]) return;
  const driver: Driver | null = await ctx.store.getDriver(plan.driverId);
  const to = toE164(driver?.phone);
  // Remember the state first, so a second push arriving while we send doesn't send it twice.
  await ctx.store.updateBooking(row.id, { driver_notified: plan.sig });
  const { addEvents } = await import("./emsp/service");
  const label = channel === "whatsapp" ? "WhatsApp" : "Text";
  if (!driver || !to) {
    if (driver && plan.kind !== "cancelled") {
      await addEvents(ctx, row, [{ kind: "NOTE", message: `${label} not sent: ${driver.name} has no valid mobile number` }]);
    }
    return;
  }
  const loc = (await ctx.store.getObject<Location>("locations", row.cpo_country_code, row.cpo_party_id, row.location_id))?.data;
  const body = messageText(plan.kind, {
    site: loc?.name ?? loc?.address ?? "the charging site", start_at: row.start_at, end_at: row.end_at, plate: row.plate,
    url: passLink(ctx, row.pass_token), tz: loc?.time_zone || DEFAULT_TZ, now: ctx.now(), deskPhone: fleet.desk_phone,
  });
  const masked = to.slice(0, -4).replace(/\d/g, "•") + to.slice(-4);
  if (ctx.mode === "demo") {
    await addEvents(ctx, row, [{ kind: "NOTE", message: `${label} to ${driver.name} (demo, not actually sent): ${body}`, data: { notify: plan.kind, channel } }]);
    return;
  }
  const res = await sendTwilio(ctx, channel, to, body);
  await addEvents(ctx, row, [res.ok
    ? { kind: "NOTE", message: `${label} sent to ${driver.name} (${masked})`, data: { notify: plan.kind, channel, sid: res.sid } }
    : { kind: "NOTE", message: `${label} to ${driver.name} failed: ${res.error}`, data: { notify: plan.kind, channel, failed: true } }]);
}

async function sendTwilio(ctx: Ctx, channel: NotifyChannel, to: string, body: string): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const e = ctx.env;
  const sid = e.TWILIO_ACCOUNT_SID!;
  const form = new URLSearchParams();
  if (channel === "whatsapp") {
    form.set("To", `whatsapp:${to}`);
    form.set("From", `whatsapp:${e.TWILIO_WHATSAPP_FROM}`);
  } else {
    form.set("To", to);
    form.set("From", e.TWILIO_FROM!);
  }
  form.set("Body", body);
  try {
    const res = await ctx.transport(new Request(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${sid}:${e.TWILIO_AUTH_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    }));
    const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string; code?: number };
    if (!res.ok) return { ok: false, error: json.message ? `${json.message}${json.code ? ` (${json.code})` : ""}` : `HTTP ${res.status}` };
    return { ok: true, sid: json.sid ?? "" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}
