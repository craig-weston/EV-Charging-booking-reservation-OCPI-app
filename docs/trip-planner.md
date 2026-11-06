# Trip planner

**Book → Plan a trip** works out charging stops for a long run. It lines them up with the driver's
45-minute breaks, finds a bookable slot at each stop, and books them all in one go.

## Routes

The trip follows a real lorry route when the deployment has a free OpenRouteService key. The route
uses OpenRouteService's heavy goods vehicle profile and avoids roads the truck can't use:

- low bridges and height limits;
- width, length and weight limits;
- roads closed to dangerous goods, if the truck carries them.

What happens with the route:

- **The truck's size** comes from Fleet (height, width, length, gross weight, dangerous goods).
  Leave a size out, and nothing is restricted for it. Vans follow car roads.
- **Distance and driving time** come from the route. The planner can still set an average speed
  under **Assumptions**.
- **Stops** are taken from charging sites within 20 km of the route, and the detour counts towards
  each leg.
- **The map** shows the route in blue with each stop numbered. The attribution under it credits
  OpenRouteService and OpenStreetMap, as their terms require.

Without a key, if the route service is unavailable, or if no road route suits the truck, the planner
falls back to the straight line plus 20% for roads. The map shows a dashed line and the summary
says "estimate".

## Switching on lorry routes

1. Sign up free at [openrouteservice.org](https://openrouteservice.org) and copy your API key from
   the dashboard.
2. In Cloudflare, go to **Workers & Pages → your Worker → Settings → Variables and Secrets** and add
   a secret named `ORS_API_KEY` with the key. Or run `npx wrangler secret put ORS_API_KEY`.

## How it works

The Worker asks OpenRouteService through `GET /api/public/route`, with these parameters:

| Parameter | What it is |
|---|---|
| `from`, `to` | Two of the planner's place names |
| `kind` | `hgv`, `bus` or `van` |
| `h`, `w`, `l` | Height, width and length, in metres |
| `t` | Gross weight, in tonnes |
| `hz` | `1` for dangerous goods |

How requests are kept low:

- Sizes are rounded, so the same truck on the same run is one route.
- Each route is kept for a week, at the edge and in the Worker.
- A planner uses a handful of requests a day, well inside the free plan's daily allowance.
- The endpoint is rate limited like the other public endpoints.
- Only the planner's named places are accepted, so it can't be used as a general routing service.

The in-browser demo asks the deployment it's running on, so demo visitors see real routes too
when the deployment has a key.
