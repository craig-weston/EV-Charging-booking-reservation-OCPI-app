# Number-plate lookup

Type a UK number plate and the app fills in the truck: on the [public map](public-map.md) ("Your truck's number plate") and in **Fleet → Add vehicle** ("Find details").

## What it finds

From DVLA's [Vehicle Enquiry Service](https://developer-portal.driver-vehicle-licensing.api.gov.uk/apis/vehicle-enquiry-service/vehicle-enquiry-service-description.html) (free):

| From DVLA | Used for |
| --- | --- |
| Make, year, colour | The vehicle's description |
| Fuel type | Whether it's electric today |
| Revenue weight | Gross weight |
| Wheel plan and type approval | Artic, rigid, van or bus |

DVLA doesn't hold the model, dimensions, battery size or connectors. Dimensions are filled with typical ones for that kind and weight of truck, and the form says to check them. The charging ID (Plug & Charge or Autocharge) is still entered by hand.

## Matching sites to the truck

On the map, the truck you pick becomes a spec card, **Sites matched to PN74 EVH**: length, height, weight, battery and top charging rate, each marked **DVLA**, **typical** or **yours**. Correct any of them under "Correct its size or charging" (and tick MCS if the truck takes megawatt charging). Every site is then checked against that truck (`src/publicmap/logic.ts`):

- **Plug:** a site needs CCS (or MCS, for an MCS truck). CHAdeMO-only sites are dropped.
- **Size and weight:** against the operator's published bay limits, where there are any. A site whose bays are too small is ruled out.
- **Charging:** the rate is the lower of the site's and the truck's. The list shows the miles a 45-minute break adds; the site's checklist shows 20–80% time for the truck's battery.
- **Fits:** built for trucks, or fleets have reported that this kind of truck fits.

The card counts the sites it can charge at, those that add 100+ miles in a 45-minute break, and those confirmed to fit. Few operators publish bay sizes yet, so "confirmed to fit" is small until they do or fleets report.

## Where details are saved

- **On the map (no account):** trucks you find are saved in your browser ("Your trucks") with any figures you correct, and the map sets itself up for the one you pick. Nothing is stored on the server.
- **In the app:** the Fleet page offers the trucks you looked up on the map ("Add"), with the details filled in, including the size, battery and charging rate set on the map. Saving adds them to the fleet like any vehicle.

## Setting it up

1. Apply for a free Vehicle Enquiry Service API key on DVLA's developer portal.
2. Add it as the secret `DVLA_API_KEY` (Cloudflare → the Worker → Settings → Variables and Secrets).

Without the key, lookups answer "not set up" and people pick a kind of truck or type the details instead.

## How it works

`POST /api/public/plate` with `{ "plate": "PN74 EVH" }` (`server/plates.ts`). It needs no account, so it is limited to 12 lookups a minute per visitor, answers are kept in memory for a day to spare DVLA's quota, and responses are never cached at the edge. It's a POST so plates stay out of URLs and logs. Plates aren't stored.
