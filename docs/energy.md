# Energy: prices, grid carbon and smart timing

## Time-of-use prices

Operators publish prices over OCPI Tariffs. A cheaper night rate or a pricier evening peak is an
`ENERGY` price component on a `TariffElement` with `start_time` / `end_time` (and optionally
`day_of_week`) restrictions, listed before the all-day rate. OCPI applies the first element that
matches, so `shared/energy/price.ts` does the same, in the site's local time (`Europe/London`,
including the clock changes).

- `energyPriceAt(tariffs, when)` is the rate at one instant.
- `averageEnergyPrice(tariffs, start, end)` averages a charge across rate changes.
- The booking screen's cost estimate uses the slot's average rate, and the tariff summary shows the
  all-day rate plus any timed rates ("£0.59 per kWh, £0.45 22:00–06:00").

The CPO simulator gives VoltHaul a night rate, Kestrel a weekday 16:00–19:00 peak and DepotShare
an overnight rate, and bills charges with the same functions.

## Grid carbon

`GET /api/energy/carbon?postcode=NN4%207PB&from=…&to=…` returns half-hourly g CO₂/kWh.

- **Live:** NESO's free [Carbon Intensity API](https://carbonintensity.org.uk) (no key), regional
  by postcode district. Forecasts run 48 hours ahead and history is available. Ranges are fetched
  in 13-day chunks and cached in memory (30 minutes for forecasts, 12 hours for history).
- **Gaps** (beyond the forecast, or if NESO is unreachable) are filled with a modelled series with
  the usual GB daily shape, marked `modelled: true`. The response's `source` says `neso`, `mixed`
  or `modelled`, and the app shows that next to anything it draws from it.
- **Demo mode** is fully modelled, so it works offline and visitors' browsers never call out.

Bands for colour and labels are fixed g/kWh thresholds (`CARBON_BANDS`).

## Cheapest and greenest slots

`smartPicks` scores every feasible start within 12 hours of the time asked for by energy cost (at
the estimated kWh) and average carbon intensity. The booking screen offers:

- **Cheapest** when it saves at least £1 against the slot nearest the time asked for.
- **Greenest** when it's at least 10% lower carbon.
- A "good timing" note when neither beats the time asked for.

The slot picker draws a carbon (or price) strip under the bay availability, darker meaning cleaner
(or cheaper), and the summary bar shows the slot's estimated CO₂.

## Savings: charging at cleaner, cheaper times

`timingReport` (Savings page) works out, for the period's charges:

- the kWh-weighted grid carbon of the half-hours actually charged in, against the average of those
  whole days, and the CO₂ that timing avoided;
- off-peak savings: kWh × (all-day rate − rate actually paid), negative if charges fell in peaks;
- what moving each charge by up to three hours to its cleanest window would have avoided;
- the share of energy by hour of day.

The headline CO₂e on the Savings page still uses the government's annual grid factor, as carbon
reporting standards expect. The half-hourly figures are for operational decisions.

## Smart charging at public sites (OCPI ChargingProfiles)

For a booked public charge, a planner can choose one of three modes in the booking drawer:

- **Cheapest:** reach a target charge by the end of the booking, in the cheapest half-hours.
- **Greenest:** reach the target in the cleanest half-hours.
- **Limit power:** cap the power.

The schedule goes to the operator over the OCPI **ChargingProfiles** module. We're the Sender
(smart charging service provider) and the operator is the Receiver.

| Message | |
|---|---|
| `PUT {cpo chargingprofiles}/{session_id}` | `SetChargingProfile { charging_profile (W, periods in seconds), response_url }` |
| `DELETE {cpo chargingprofiles}/{session_id}?response_url=…` | Switch it off (back to full power) |
| `POST {our response_url}` | `ChargingProfileResult` / `ClearProfileResult`: the charger's own answer |
| `PUT {our chargingprofiles}/{session_id}` | `ActiveChargingProfile`: what the charger is actually doing |

How it behaves:

- **Before arrival:** set up before the truck arrives, the profile waits and is sent (re-planned
  from the real start and state of charge) when the session starts.
- **Operator answers:** the synchronous answer (`ACCEPTED`, `NOT_SUPPORTED`, `REJECTED`,
  `TOO_OFTEN`, `UNKNOWN_SESSION`) and the charger's result are shown on the booking.
- **No support:** operators whose endpoint list has no `chargingprofiles` module are never
  called, and the booking says the truck will charge at full power.
- **Operator guide:** shows whether each connected operator offers the module.

In the simulator, VoltHaul and DepotShare apply profiles (the session's energy follows them minute
by minute) and Kestrel answers `NOT_SUPPORTED`. The column is `bookings.smart_charging`
(migration `20261103000000_smart_charging.sql`).
