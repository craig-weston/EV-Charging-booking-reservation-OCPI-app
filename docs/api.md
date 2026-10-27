# API for fleet systems

Your own systems (a TMS, telematics, dispatch or an autonomous vehicle platform) can find charging
bays and book them through the same API the web app uses, without anyone signing in.

## API keys

A fleet owner creates keys in **Settings → API keys**:

- **Book and read** (planner): reads the network, trucks, drivers and bookings, and books, changes
  and cancels slots.
- **Read only** (viewer): reads only.

A key works for one fleet. It can't manage the team, change fleet settings, export data, see the
activity log or use admin pages. The key is shown once when it's created; only a SHA-256 hash is
stored, so a lost key can't be recovered, only revoked and replaced. Keys can expire (90 days,
1 year) or not; revoking one stops it working immediately. Every key shows when it was last used,
and creating or revoking one is recorded in the activity log.

Send the key with every request, in either header:

```http
Authorization: Bearer fck_…
X-API-Key: fck_…
```

Keys start with `fck_`, so a leaked key is easy to spot in logs and repositories. Treat a key like a
password: keep it in your system's secret store, never in code or a browser.

## Booking a bay

Base URL: your deployment, for example `https://book.example.com/api`. Responses are JSON, with the
result in `data` or an `error` with a `message` and `code`.

1. **Find the truck.** `GET /fleets/{fleet_id}/vehicles` lists the fleet's trucks with their
   connectors, power, size and Plug & Charge or Autocharge identity.
2. **Find bays.** `GET /network` returns every connected operator's sites (`locations`), bookable
   bays with their availability (`booking_locations`, each with `calendars`) and prices (`tariffs`),
   all in OCPI 2.3.0 format.
3. **Book.** `POST /fleets/{fleet_id}/bookings`:

   ```json
   {
     "vehicle_id": "…",
     "cpo_country_code": "GB",
     "cpo_party_id": "VHL",
     "booking_location_id": "VHL-LUT-CCS",
     "start_at": "2026-10-28T13:00:00Z",
     "end_at": "2026-10-28T13:45:00Z",
     "power_required_kw": 350,
     "driver_id": null
   }
   ```

   The answer is the booking with `reservation_status` `PENDING`; the operator confirms it
   (`RESERVED`) or rejects it within seconds. A truck that doesn't fit the bay (connector, power,
   size, dangerous goods, reefer power) is refused with status 422 and the reason.
4. **Follow it.** `GET /fleets/{fleet_id}/bookings/{id}` shows the status, the operator's terms,
   the live charging `session` (energy, power, battery level) and the final charge record.
   `GET /fleets/{fleet_id}/bookings?from=…&to=…` lists bookings with recent events.
5. **Change or cancel.** `POST /fleets/{fleet_id}/bookings/{id}/change` with `start_at` and
   `end_at`; `POST /fleets/{fleet_id}/bookings/{id}/cancel` with an optional `reason`.

Bookings made with a key record the key in `created_by_key`.

## Limits

Requests are rate limited per IP address (status 429 with `Retry-After`) and request bodies are
capped at 256 KB. Errors: 401 `INVALID_API_KEY` (unknown, revoked or expired key), 403
`API_KEY_SCOPE` (outside what keys may do), 403 for a write with a read-only key, 404 for anything
outside the key's fleet.
