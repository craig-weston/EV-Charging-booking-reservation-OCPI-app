# Depot smart charging

The **Depot smart charging** page plans charging at a fleet's own depots. Every truck is charged
in the cheapest and cleanest half-hours that still get it to the charge it needs before it leaves,
without going over the site's grid connection.

## Setting up (fleet owners)

**Depot settings** holds, per depot:

- **Site:** name, postcode (for regional grid carbon), grid connection in kW, and other site load
  to keep free (lighting, warehouse, reefers).
- **Plan for:** lowest cost, balanced (carbon valued at £100 a tonne) or lowest carbon.
- **Electricity tariff:**
  - one rate;
  - time of use (a standard rate plus timed rates, optionally weekdays only);
  - half-hourly Octopus Agile prices by product code and region. These come from Octopus's public
    API, with a modelled fallback that's labelled as such.
- **Chargers:** name, OCPP station id, EVSE id and maximum kW.
- **Control:** how schedules reach the chargers (see below), and whether to re-send them
  automatically every 15 minutes.

Settings are stored in `fleet_energy` (migration `20261102000000_depot_energy.sql`). Credentials
are sealed with `DATA_ENCRYPTION_KEY` and never sent back to browsers.

## Trucks (depot visits)

Planners add each truck's stay with:

- arrival and departure;
- charge on arrival and charge needed;
- optionally a charger.

Trucks can share a charger one after another; overlapping use of a charger is refused. A fleet's
own systems can send visits through the API with a fleet API key:

```
POST /api/fleets/{fleet}/depot-visits
{ "depot_id": "yard", "vehicle_id": "…", "charger_id": "bay-1",
  "arrive_at": "2026-10-29T18:30:00Z", "depart_at": "2026-10-30T05:15:00Z",
  "soc_start": 21, "soc_target": 90 }
```

`GET /api/fleets/{fleet}/depots/{depot}/plan` returns the plan. It includes kW per half-hour per
truck, cost, CO₂, the time each truck will be ready, any shortfall, and the "charge on arrival"
baseline for comparison.

## How the plan is worked out

`shared/energy/optimise.ts` solves it as a minimum-cost flow:

```
source → truck (kWh needed) → charger × half-hour (charger kW) → half-hour (site headroom) → sink
```

- **Departure guarantee:** maximum flow comes first, so every truck is filled whenever that's
  physically possible.
- **Cost:** among those plans, the cheapest is chosen (price, plus carbon at the goal's weight).
- **Shortfalls:** trucks that can't be filled in time are shown with their shortfall rather than
  silently dropped.
- **Energy needed:** battery kWh × (target − arrival %) ÷ 93% charging efficiency.
- **Truck power:** limited by the lower of the charger's and the truck's maximum kW.

## Sending schedules to chargers

Each charger with planned charging gets an OCPP 2.0.1 `SetChargingProfileRequest` with:

- `TxDefaultProfile`, `Absolute`, rate unit W;
- a limit for every half-hour;
- a stable profile id, so a new plan replaces the old one;
- an end at the last departure, so chargers fall back to their own settings if the connection is
  lost.

Ways to reach the chargers:

| Control | What happens |
|---|---|
| Not yet (simulated) | The plan is recorded, nothing leaves the app. The demo uses this. |
| CitrineOS | `POST {base}/ocpp/2.0.1/smartcharging/setChargingProfile?identifier={station}&tenantId={tenant}`, with an optional Bearer token. CitrineOS is a free, open-source charger management system (OCPP 2.0.1). |
| Depot operator's system | The same request in a JSON envelope, posted to their address and signed with `Depotcharge-Signature` (the same scheme as fleet webhooks, see `docs/webhooks.md`). |

The worker's cron trigger (`*/15 * * * *` in `wrangler.jsonc`) re-plans and re-sends schedules for
depots with automatic sending switched on (`server/depot.ts → runDepotDispatch`).

## Limits

- Plans cover up to 72 hours ahead.
- Current charge levels come from what planners or the API report; live meter values from the
  charger management system aren't read back yet.
- On the Workers free plan (10 ms CPU per request), very large depots (dozens of trucks over
  several days) may need the paid plan's CPU allowance.
