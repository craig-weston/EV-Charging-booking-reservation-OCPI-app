# Webhooks

Fleet owners can have Depotcharge tell their own systems (a TMS, dispatch board or telematics
platform) whenever one of their bookings changes. Settings → Webhooks → Add webhook.

## Delivery

Each event is an HTTPS `POST` with a JSON body to the address you gave (public `https://` only):

```http
POST /hooks/depotcharge HTTP/1.1
Content-Type: application/json
User-Agent: Depotcharge-Webhooks/1
Depotcharge-Event: booking.confirmed
Depotcharge-Delivery: 7d4c0e1e-…
Depotcharge-Signature: t=1793188800,v1=5f2b…

{
  "id": "7d4c0e1e-…",
  "type": "booking.confirmed",
  "created_at": "2026-10-28T12:00:00.000Z",
  "fleet_id": "…",
  "data": {
    "booking": {
      "id": "…", "reference": "HS-UZJXZ6ZZ8AWXNX28", "status": "RESERVED", "pending_action": null,
      "vehicle_id": "…", "plate": "PN74EVH", "driver_id": null,
      "operator": { "country_code": "GB", "party_id": "VHL" }, "location_id": "VHL-DIRFT",
      "start_at": "2026-10-29T11:00:00Z", "end_at": "2026-10-29T12:00:00Z",
      "charging": null, "charge_record": null, "updated_at": "…"
    },
    "event": { "kind": "RESERVED", "message": "Confirmed by VoltHaul", "at": "…" }
  }
}
```

Answer with any `2xx` within 8 seconds. A failed delivery is retried once straight away; after 20
failures in a row the webhook is switched off (turn it back on in Settings). Deliveries can arrive
more than once or out of order: use `Depotcharge-Delivery` to ignore repeats and `updated_at` to keep
the newest state.

## Events

| Event | When |
| --- | --- |
| `booking.requested` | A booking was sent to the operator |
| `booking.confirmed` | The operator confirmed it |
| `booking.changed` | A new time was accepted, or a bay was assigned |
| `booking.declined` | The operator turned down a booking or a change |
| `booking.cancelled` | The booking was cancelled, by you or the operator |
| `booking.no_show` | The slot was released because the truck didn't arrive |
| `charging.started` | The truck started charging |
| `charging.completed` | Charging finished |
| `charge_record.received` | The operator's charge record arrived |
| `webhook.test` | You pressed Send test |

## Checking the signature

`Depotcharge-Signature: t=<unix seconds>,v1=<hex>` where `v1` is HMAC-SHA256 of `"<t>.<raw body>"`
with your signing secret (`whsec_…`, shown once when you add the webhook). Reject deliveries whose
signature doesn't match, or whose `t` is more than 5 minutes old.

```js
import crypto from "node:crypto";

function verify(rawBody, header, secret) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${rawBody}`).digest("hex");
  const fresh = Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
  return fresh && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ""));
}
```

## API

Owners only (not API keys): `GET /api/fleets/{id}/webhooks`, `POST` with `{ "url", "description"?, "events"? }`
(returns the secret once), `PATCH /api/fleets/{id}/webhooks/{hook}` with `{ "active"?, "events"?, "description"? }`,
`DELETE …/{hook}`, and `POST …/{hook}/test`. Five webhooks per fleet.
