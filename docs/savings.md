# Savings report

Savings (`#/savings`) estimates the fuel cost and CO₂e a fleet avoided by charging electric trucks
instead of running diesel ones. It uses only charges booked through the platform, from the
operators' charge records.

For each charge:

- **Distance** = energy (kWh) ÷ energy use for the truck type (kWh/km)
- **Diesel avoided** = distance × diesel use for that type (L/100 km) ÷ 100
- **Fuel cost saved** = diesel avoided × diesel price − what the charge cost (operator price + platform
  margin), both ex VAT
- **CO₂e avoided** = diesel avoided × diesel factor − energy × grid factor

## Default assumptions

| Assumption | Value | Source |
| --- | --- | --- |
| Diesel price | £1.66 a litre ex VAT | Record UK pump price of 199.18p on 28 Sep 2026 (RAC), less 20% VAT |
| Diesel carbon | 2.58354 kg CO₂e/L | UK government GHG conversion factors 2026, diesel (average biofuel blend) |
| Grid carbon | 0.13096 kg CO₂e/kWh | UK government GHG conversion factors 2026, UK electricity generation |
| Artic / tractor | 1.3 kWh/km vs 36 L/100 km | Trip planner default; artics average about 7.9 mpg |
| Rigid | 0.95 kWh/km vs 26 L/100 km | Typical |
| Bus / coach | 1.1 kWh/km vs 30 L/100 km | Typical |
| Van | 0.3 kWh/km vs 10 L/100 km | Typical |

Fleets can change every assumption on the page (saved in that browser). Grid transmission losses
and renewable-backed tariffs aren't modelled. **Copy summary** gives one sentence for reports and
posts; **Download CSV** gives a row per truck, the total and the assumptions used.

Official factors: https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026
