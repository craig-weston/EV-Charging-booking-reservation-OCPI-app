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

## Where details are saved

- **On the map (no account):** trucks you find are saved in your browser ("Your trucks"), and the map sets itself up for the one you pick. Nothing is stored on the server.
- **In the app:** the Fleet page offers the trucks you looked up on the map ("Add"), with the details filled in. Saving adds them to the fleet like any vehicle.

## Setting it up

1. Apply for a free Vehicle Enquiry Service API key on DVLA's developer portal.
2. Add it as the secret `DVLA_API_KEY` (Cloudflare → the Worker → Settings → Variables and Secrets).

Without the key, lookups answer "not set up" and people pick a kind of truck or type the details instead.

## How it works

`POST /api/public/plate` with `{ "plate": "PN74 EVH" }` (`server/plates.ts`). It needs no account, so it is limited to 12 lookups a minute per visitor, answers are kept in memory for a day to spare DVLA's quota, and responses are never cached at the edge. It's a POST so plates stay out of URLs and logs. Plates aren't stored.
