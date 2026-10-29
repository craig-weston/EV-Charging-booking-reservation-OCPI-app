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
