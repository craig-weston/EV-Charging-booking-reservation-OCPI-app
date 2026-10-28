// Webhooks: tell a fleet's own systems (TMS, dispatch, telematics) when one of its bookings
// changes, so nobody has to watch the app. Deliveries are signed (HMAC-SHA256) with a per-endpoint
// secret, sent after the response (waitUntil), retried once, and an endpoint that keeps failing
// is switched off. See docs/webhooks.md for the payload and how to verify the signature.
import type { BookingEvent, BookingEventKind, BookingRow, FleetWebhookRow, WebhookEvent } from "../shared/model";
import { iso, uuid } from "../shared/util";
import type { Ctx } from "./context";
import { openSecret } from "./security";

/** Consecutive failures before an endpoint is switched off (the owner can switch it back on). */
export const MAX_FAILURES = 20;
const TIMEOUT_MS = 8000;
const enc = new TextEncoder();

/** Which booking event kinds become which webhook event (others, e.g. notes, aren't sent). */
export const EVENT_FOR_KIND: Partial<Record<BookingEventKind, WebhookEvent>> = {
  REQUESTED: "booking.requested",
  RESERVED: "booking.confirmed",
  CHANGE_ACCEPTED: "booking.changed",
  BAY_ASSIGNED: "booking.changed",
  REJECTED: "booking.declined",
  FAILED: "booking.declined",
  CHANGE_DECLINED: "booking.declined",
  CANCELED: "booking.cancelled",
  NO_SHOW: "booking.no_show",
  SESSION_STARTED: "charging.started",
  SESSION_COMPLETED: "charging.completed",
  CDR_RECEIVED: "charge_record.received",
};

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>" (the same scheme Stripe uses). */
export async function signature(secret: string, body: string, at: Date): Promise<string> {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/** What a webhook says about a booking: enough to act on without calling back. */
export function bookingPayload(b: BookingRow) {
  return {
    id: b.id,
    reference: b.authorization_reference,
    status: b.reservation_status,
    pending_action: b.pending_action?.kind ?? null,
    vehicle_id: b.vehicle_id,
    plate: b.plate,
    driver_id: b.driver_id,
    operator: { country_code: b.cpo_country_code, party_id: b.cpo_party_id },
    location_id: b.location_id,
    start_at: b.start_at,
    end_at: b.end_at,
    charging: b.session ? { status: b.session.status, kwh: b.session.kwh ?? null } : null,
    charge_record: b.cdr ? { id: b.cdr.id, kwh: b.cdr.total_energy, ended_at: b.cdr.end_date_time } : null,
    updated_at: b.updated_at,
  };
}

export interface Delivery { id: string; type: WebhookEvent | "webhook.test"; created_at: string; fleet_id: string; data: Record<string, unknown> }

/** Sends one delivery to one endpoint (one retry), records the result. Never throws. */
export async function deliver(ctx: Ctx, hook: FleetWebhookRow, d: Delivery): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  let secret: string | null;
  try {
    secret = await openSecret(hook.secret, ctx.env.DATA_ENCRYPTION_KEY, ctx.env.DATA_ENCRYPTION_KEY_PREVIOUS);
  } catch {
    secret = null;
  }
  const body = JSON.stringify(d);
  let status: number | null = null;
  let error: string | null = null;
  if (!secret) error = "The signing secret couldn't be read (check DATA_ENCRYPTION_KEY)";
  for (let attempt = 0; attempt < 2 && secret && !(status && status < 300); attempt++) {
    try {
      const req = new Request(hook.url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Depotcharge-Webhooks/1",
          "Depotcharge-Event": d.type,
          "Depotcharge-Delivery": d.id,
          "Depotcharge-Signature": await signature(secret, body, ctx.now()),
        },
        body,
      });
      const res = await ctx.transport(req);
      status = res.status;
      error = res.ok ? null : `HTTP ${res.status}`;
      await res.body?.cancel().catch(() => undefined);
    } catch (e) {
      status = null;
      error = e instanceof Error && e.name === "TimeoutError" ? `No answer within ${TIMEOUT_MS / 1000} s` : "Couldn't connect";
    }
  }
  const ok = !!status && status >= 200 && status < 300;
  const failures = ok ? 0 : hook.failures + 1;
  await ctx.store.updateWebhook(hook.id, {
    last_attempt_at: iso(ctx.now()), last_status: status, last_error: error, failures,
    ...(failures >= MAX_FAILURES ? { active: false } : {}),
  }).catch(() => undefined);
  hook.failures = failures;
  return { ok, status, error };
}

/** After booking events are stored: tell the fleet's active endpoints that asked for them. */
export async function notifyWebhooks(ctx: Ctx, fleetId: string, bookingId: string, events: BookingEvent[]): Promise<void> {
  const kinds = events.map((e) => ({ e, type: EVENT_FOR_KIND[e.kind] })).filter((x): x is { e: BookingEvent; type: WebhookEvent } => !!x.type);
  if (!kinds.length) return;
  const hooks = (await ctx.store.listWebhooks(fleetId).catch(() => [])).filter((h) => h.active);
  if (!hooks.length) return;
  const booking = await ctx.store.getBooking(bookingId).catch(() => null);
  if (!booking) return;
  for (const { e, type } of kinds) {
    const d: Delivery = { id: uuid(), type, created_at: e.at, fleet_id: fleetId, data: { booking: bookingPayload(booking), event: { kind: e.kind, message: e.message, at: e.at } } };
    for (const h of hooks) if (h.active && (!h.events.length || h.events.includes(type))) await deliver(ctx, h, d);
  }
}
