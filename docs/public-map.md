# Public charging map

`/map` is a public page, with no sign-in, showing every public charging site in the UK with 150 kW or more (from [open data](open-data.md)) on a street map. "Book a slot" opens the app, which asks people to sign in first.

## What it does

- **Street map** from [OpenFreeMap](https://openfreemap.org) (free, no key), recoloured at load into a night map so the pins stand out. Drawn with [MapLibre GL JS](https://maplibre.org) 6.17 (BSD-3-Clause), served from `public/vendor/maplibre-6.17.0` rather than bundled.
- **Pins** in three colours: mint for sites that suit trucks (built for them, or fleets say an artic fits), electric blue for 350 kW and up, cyan for the rest. Pins cluster when zoomed out; a cluster with truck sites has a mint ring.
- **Search** for a town, site name or postcode; **filters** for power (150 / 350 kW+), "Suits trucks", megawatt (MCS) connectors and operator.
- **The list** shows what's in view, truck sites first, then the most powerful.
- **Opening hours and facilities** from operators' feeds: a 24/7 filter and tag, and café, food, hotel, fuel, Wi-Fi, parking and shop icons where published.
- **Site details**: operator, address, whether an artic fits (operator data plus [fleets' reports](open-data.md#reports-from-fleets)), top power, chargers, connectors, bay limits where published, directions and a shareable link (`/map#site=<id>`).
- **A gateway to the app**, for sharing with anyone:
  - a welcome card on first visit;
  - "Try booking this site": a trial booking that walks through the day (bay held, gate opens on the plate, Plug & Charge, one invoice). Nothing is booked;
  - "Try the app free": the full app with sample data, at `/?demo#/book`;
  - a Share button.

  Link previews (LinkedIn, WhatsApp, Slack) use `public/og-map.jpg`, and robots.txt lets preview bots read `/map` only.
- **Near me** asks the browser for the visitor's location; it's used only in the browser.

Motion (the fly-in, pulsing rings, glowing buttons) is turned off for people who ask their device for reduced motion.

## Privacy and security

The visitor's browser fetches map images, styles and fonts straight from `tiles.openfreemap.org`, which sees their IP address and the map area; the [privacy notice](../src/legal/documents.tsx) says so. `public/_headers` allows that host in `connect-src`, MapLibre's worker from the site itself (`worker-src 'self'`), and location for "Near me" (`geolocation=(self)`). No third-party scripts are loaded.

## Code

- `src/publicmap/map.tsx`: the entry, built to `dist/map.html` by `scripts/build.mjs`.
- `src/publicmap/PublicMap.tsx`: the page and the map layers.
- `src/publicmap/logic.ts`: filters, order, search and truck access (tested in `tests/public-map.test.ts`).
- `src/publicmap/publicmap.css`: the look.
