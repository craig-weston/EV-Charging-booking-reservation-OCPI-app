# Public charging sites (open data)

The booking map shows two kinds of site:

- **Bookable sites**: operators connected over OCPI (the filled pins with prices). Fleets book slots here.
- **Public sites, not bookable here yet**: real UK charging sites from open data (hollow diamonds). They're there so planners can see the whole picture: what's near a route, and where a truck could charge on site by card or the operator's app. They are read-only.

Only sites that could serve heavy vehicles are kept:

| Shown as | When |
|---|---|
| **Built for trucks** (teal) | The operator publishes truck bays (OCPI 2.3 parking with semi-tractor, rigid, truck-with-trailer or bus), an MCS connector, the site belongs to a truck charging network, or the listing says it's for HGVs |
| **Bay size not published** (grey) | 150 kW or more, but no bay sizes. For HGVs the site panel says to check before sending a truck; vans are fine |

Where an operator publishes bay limits (length, height, weight), sites a truck doesn't fit are hidden for that truck. Copies of sites that are already bookable here are hidden too.

## Where the data comes from

1. **Operators' statutory feeds.** The Public Charge Point Regulations 2023 require every UK public charge point operator to publish open data about its sites free of charge, mostly as OCPI. Feeds that open without a key are used by default: GeniePoint, MFG EV Power, Evolt, ChargePlace Scotland, PoGo Charge and Arnold Clark Charge. Others (GRIDSERVE, bp pulse, IONITY, Shell Recharge, Allego, Fastned, Osprey) send a free key or token when you ask; the operator's open-data page is linked in `shared/opendata/sources.ts`.
2. **Open Charge Map** fills the gaps: a free, community-maintained map. Its community data is licensed CC BY 4.0; records it imported from other providers keep their providers' terms. Each site panel names its source.

Endpoints and access methods come from the community register of UK operators' open-data feeds ([osholt/tailendcharlie](https://github.com/osholt/tailendcharlie), `docs/ev-charging-open-data-feeds.md`).

## How it updates

- `.github/workflows/opendata.yml` runs daily at 04:41 UTC (and on demand from the Actions tab). It runs `scripts/opendata.ts`, which fetches every source, keeps the sites that could serve trucks, merges duplicates (an operator's own record beats an aggregator's copy) and writes one compact file, `sites.json`.
- The file is published as an asset on the `opendata` release. Nothing is committed, so it never triggers a deploy.
- The app reads it through `GET /api/public/sites`, cached at the edge for an hour. Set `OPEN_SITES_URL` in the Worker's settings to use another copy.
- Without a server (the static preview, tests) the map shows bookable sites only.

## Adding keys

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Get it from |
|---|---|
| `OCM_API_KEY` | A free account at [openchargemap.org](https://openchargemap.org/site/develop/api) → My Apps → Register an application |
| `OPEN_DATA_GRIDSERVE_KEY` | [gridserve.com/open-data](https://www.gridserve.com/open-data/) |
| `OPEN_DATA_BP_PULSE_TOKEN`, `OPEN_DATA_IONITY_TOKEN`, `OPEN_DATA_SHELL_TOKEN`, `OPEN_DATA_ALLEGO_TOKEN` | Each operator's open-data request form; tokens are issued through Eco-Movement |
| `OPEN_DATA_FASTNED_KEY` | [fastnedcharging.com/en-gb/uk-open-data](https://www.fastnedcharging.com/en-gb/uk-open-data) |
| `OPEN_DATA_OSPREY_BASIC` | Osprey's open-data page; save as `username:password` |

Then run the **Open data** workflow once from the Actions tab. Its log lists how many sites each source contributed.

## Adding a source

Add an entry to `SOURCES` in `shared/opendata/sources.ts` (and, if it needs a key, the secret to the workflow's `env`). OCPI 2.1.1, 2.2.1 and 2.3 Locations are all understood, paginated with `Link: <…>; rel="next"`.
