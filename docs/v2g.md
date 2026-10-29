# Vehicle-to-grid pilot

A depot can run a V2G pilot. Pilot trucks parked on bidirectional chargers give power back at
expensive times and recharge later at cheaper ones, within strict limits:

- **Minimum charge:** a pilot truck never drops below the minimum charge (default 35%).
- **Departure:** every truck still leaves with the charge it needs. The charging plan is worked
  out first, and give-back only reuses the slack around it.
- **Site only (default):** power given back only covers the site's own load (other site load and
  other trucks' charging), so it's never exported and no network approval is needed.
- **Export:** with your network operator's G99 approval, up to the approved export in kW.
- **Battery wear:** power is only given back when the price gap beats a wear cost per kWh cycled
  (default £0.06). With round-trip losses (93% each way) that means roughly:

  ```
  peak price × 0.93 − recharge price ÷ 0.93 − wear > 0
  ```

- **Warranty:** nothing is given back until the truck maker has confirmed in writing that
  bidirectional use is covered (a checkbox in pilot settings).

## How it works

`shared/energy/v2g.ts → v2gPass` runs after the charging plan. It repeatedly finds the most
valuable pair of half-hours:

1. a slot to give power back in, while the truck is plugged in, not already charging, and within
   the site, export and power limits;
2. a later slot to recharge in, within the charger's power and the site's headroom.

It moves 10 kWh of battery energy at a time and checks the truck's charge never dips below the
minimum in between. It stops when no pair beats battery wear.

The page shows:

- **Chart:** give-back as hatched bars below the axis.
- **Trucks:** each pilot truck shows "Gives back N kWh".
- **Pilot panel:**
  - a readiness checklist: bidirectional charger, pilot truck, truck on a V2G charger tonight,
    warranty, export approval or site-only mode;
  - tonight's results: energy given back, value after recharging, battery wear, net benefit
    (also per year at 250 nights), and the lowest charge reached.
- **Pilot data for funders (CSV):** the half-hourly schedule with prices, carbon, each pilot
  truck's kW (+ charge / − give back) and the results. This is for trial reports, for example to
  the government's V2X innovation programme.

## Charger control

Give-back needs OCPP 2.1 (V2X). For chargers marked **V2G**, give-back half-hours are sent as
`operationMode: "CentralSetpoint"` with a negative `setpoint` in watts. Charging half-hours are
sent as `ChargingOnly` with a limit. When a profile contains give-back, CitrineOS requests use
`/ocpp/2.1/…`. The truck and charger must both support bidirectional power transfer (ISO
15118-20 BPT).

## Status

This is a pilot. In late 2026, bidirectional charging for heavy trucks is at demonstration stage
(for example MAN's eTGX and Scania's demos), and there's no commercial V2G over MCS yet. The
planner, limits and reporting are ready for a single-truck trial on a CCS bidirectional charger.
Delivery is planned rather than metered.
