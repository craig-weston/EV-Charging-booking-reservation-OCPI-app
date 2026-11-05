# Battery levels from the trucks

Without this, a planner types each truck's arrival time and charge on arrival into the depot plan.
With it, the trucks report their own battery level, and the fleet's planning system sends the
arrival and departure times. Nobody has to type them in.

## What it does

- Keeps the latest reading for each truck: battery level (%), range, whether it's charging or
  plugged in, its position and when the truck measured it.
- **The depot plan** uses the truck's reading as its charge on arrival if two things are true:
  - the reading is no more than 3 hours old;
  - the truck is plugged in, has arrived, or is due within 30 minutes.

  A truck still hours away will use more charge before it gets there, so its typed-in figure (or
  your planning system's estimate) stays until it's nearly in. On the Depot page, a truck planned
  from its own reading shows a signal icon next to its charge.
- **The dashboard** shows each truck's latest battery level, for example "From the truck, 5 min
  ago, about 180 km left". It uses this whenever the reading is newer than the truck's last charge.

## Three ways in

### 1. rFMS (Volvo, MAN and other makers)

rFMS is the European truck makers' common fleet API. Electric trucks report remaining battery
charge, estimated distance to empty and charging status through it. Depotcharge asks for the latest
status of every truck every 15 minutes.

1. Ask your truck maker for rFMS access, through their fleet portal (for example Volvo Connect or
   MAN RIO). You get:
   - the API address;
   - either a user name and password, or an OAuth2 client ID, client secret and token address.
2. In Depotcharge: **Settings → For developers → Battery levels from the trucks → rFMS**.
   - Enter the address. Use the part before `/vehiclestatuses`, for example
     `https://api.truckmaker.example/rfms`.
   - Enter the sign-in details.
   - Enter each truck's VIN.
3. Save, then **Check now**. It says how many trucks reported. It also lists VINs the maker sent
   that aren't linked to a truck yet, so you can copy them across.

Notes:

- Built to the rFMS 2.1 and 4.0 specifications. It asks for 4.0 first and falls back to 2.1, and
  follows paging.
- Diesel trucks in the same account are ignored.
- Sign-in by user name and password (Basic) or OAuth2 client credentials. A maker whose sign-in
  works differently can still send readings through the API (way 2).
- This hasn't yet been tried with a live maker account. If your maker's answers look different,
  open an issue with an example, with VINs and positions removed.

How the password or client secret is kept:

- It's sealed with `DATA_ENCRYPTION_KEY` and never shown again.
- It's only ever sent to the hosts it was entered for. Changing the address to another host means
  entering it again.

### 2. Any telematics system, through the API

Any telematics system (an onboard unit, a gateway or another fleet platform) can send readings,
for any make. Create an API key in **Settings → API keys** with **Book and read**, then:

```http
POST /api/fleets/{fleet_id}/telemetry
Authorization: Bearer fck_…
Content-Type: application/json

{
  "readings": [
    { "plate": "PN74 EVA", "soc_pct": 47.5, "range_km": 182, "charging": "idle",
      "lat": 52.21, "lon": -0.89, "at": "2026-10-29T17:42:00Z" },
    { "vin": "YV2RT40A0NB123456", "soc_pct": 63 },
    { "vehicle_id": "…", "soc_pct": 18, "charging": "connected" }
  ]
}
```

The fields:

- **Which truck:** each reading names it by `vehicle_id`, `plate` (spaces and case don't matter)
  or `vin` (a VIN entered in the rFMS settings).
- **`soc_pct`:** 0–100. Required.
- **`at`:** when the truck measured it. Leave it out to mean now; a time in the future is refused.
- **`range_km`, `charging`, `lat`, `lon`:** optional. `charging` is one of `charging`,
  `connected`, `idle` or `error`.

The answer says how many readings were accepted, and which were rejected and why:

```json
{ "data": { "accepted": 2, "rejected": [{ "index": 2, "reason": "No vehicle with that id, plate or VIN" }] } }
```

How sending works:

- You can send up to 500 readings at a time.
- Sending the same reading twice is safe.
- An older reading never replaces a newer one.

`GET /api/fleets/{fleet_id}/telemetry` returns the latest reading per truck.

### 3. Simulated

The demo uses simulated readings, so you can see how it looks before connecting anything.

## Arrival and departure times from your planning system

Your TMS or planning system can send each trip to a depot with its own id (any UUID), and send it
again whenever the times change. The first `PUT` creates the stay (status 201); later ones update
it (status 200), so a trip is never added twice:

```http
PUT /api/fleets/{fleet_id}/depot-visits/5b0e7c1e-2f4a-4c11-9e59-0d3a3b1f2a77
Authorization: Bearer fck_…
Content-Type: application/json

{ "depot_id": "yard", "vehicle_id": "…", "charger_id": null,
  "arrive_at": "2026-10-29T17:30:00Z", "depart_at": "2026-10-30T05:15:00Z",
  "soc_start": 25, "soc_target": 90 }
```

- **`soc_start`** is your best estimate. Once the truck is close, the plan uses the truck's own
  reading instead.
- **`soc_target`** is the charge it needs to leave with.
- Leave `charger_id` empty if the bay isn't known yet.
- `DELETE` the same address if the trip is cancelled.
- An id used by another fleet is refused with status 409.

See [depot charging](depot-charging.md) for how the plan is worked out, and the
[API guide](api.md) for keys and limits.
