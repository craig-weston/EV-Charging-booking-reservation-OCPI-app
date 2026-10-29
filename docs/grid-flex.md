# Grid flexibility

Depots can be paid for:

- **Turning down:** easing off charging when the grid is stretched.
- **Turning up:** soaking up power when there's too much.

The schemes covered are:

- **NESO Demand Flexibility Service (DFS):** national, year-round, with turn-down and turn-up
  events.
- **Local network (DNO) flexibility:** easing local constraints, often tendered through Piclo.
- **Balancing Mechanism (BM):** through a Virtual Lead Party.

The app doesn't register with these schemes itself. An **aggregator** that holds the registrations
sends events to the app, and the app decides what each depot can deliver.

## The rule: no truck leaves short

For each event, `server/flex.ts → assessEvent` re-plans the depot (see `docs/depot-charging.md`):

- **Turn down:** finds the lowest charging cap in the window at which every truck still gets the
  charge it had planned (binary search on the cap). The commitment is planned load minus that cap.
- **Turn up:** pays the event price per kWh during the window, lets the optimiser move charging
  into it, and commits the extra load.

Events under 10 kW, below the depot's minimum price, or for schemes the depot hasn't chosen are
declined with a reason. Accepted events become constraints on the depot's plan, so the schedules
sent to chargers follow them.

## Settings

**Depot settings → Grid flexibility**, per depot:

- take part (on/off);
- which schemes;
- the lowest payment to accept (£/MWh);
- whether to accept automatically.

For the fleet as a whole, events come from either:

- **Simulated:** for trying it out, with a "Try an event" button on the page;
- **Your aggregator:** their name, their report address and a signing secret, sealed with
  `DATA_ENCRYPTION_KEY`.

Platform admins set the fleets' share of payments (default 80%) on the Network page, next to the
margin.

## Aggregator API

Every request and report is JSON, signed `Depotcharge-Signature: t=<unix>,v1=<hex>`. That's an
HMAC-SHA256 of `${t}.${body}` with the fleet's flex secret, the same scheme as fleet webhooks
(`docs/webhooks.md`). Requests more than 5 minutes old are refused.

**Offer an event**

```
POST /api/flex/{fleet_id}/events
{ "event_id": "AGG-123", "depot_id": "yard", "programme": "DFS" | "DNO" | "BM",
  "direction": "down" | "up", "start": "2026-10-30T17:30:00Z", "end": "2026-10-30T19:00:00Z",
  "price_per_mwh": 900, "requested_kw": 200 }

→ 201 { "id": "…", "event_id": "AGG-123", "status": "accepted" | "declined" | "offered",
        "accepted": true, "pending": false, "committed_kw": 180, "baseline_kw": 180, "reason": null }
```

- Offers are idempotent on `event_id`.
- `pending: true` means a planner will decide. The decision is posted to the aggregator's report
  address as `flex.commitment`.
- Events must start in the future and last at most 6 hours.

**Settle a delivered event**

```
POST /api/flex/{fleet_id}/events/{event_id}/settlement
{ "payment_gbp": 150.00, "delivered_kwh": 150 }
```

**Reports we send** to the aggregator's address, signed the same way:

- `flex.commitment`: on accept or decline;
- `flex.delivery`: after the event, with the estimated delivered kWh.

## Payment and statements

After an event ends (on page load, or the 15-minute cron), an accepted event becomes
**delivered**:

- delivered kWh = committed kW × hours, which assumes the plan was followed;
- payment = kWh ÷ 1000 × £/MWh;
- the fleet's share is the platform's flex share percentage.

These figures are marked *estimated* until the aggregator's settlement replaces them.

The monthly statement lists each event's credit after the charges, then shows the **amount due**
(charges including VAT, minus credits). Credits are shown without VAT; check their VAT treatment
with an accountant.

## Limits

- Delivery is estimated from the plan, not metered; live meter values from the charger management
  system aren't read back yet.
- One aggregator per fleet.
- Data lives in `flex_events` (migration `20261104000000_grid_flex.sql`).
