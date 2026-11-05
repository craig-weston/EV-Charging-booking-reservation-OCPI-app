// Where public charging-site data comes from. Feeds that open without a key run by default; the
// others need a free key or token from the operator (most send one by email under the Public Charge
// Point Regulations 2023) saved as a GitHub Actions secret with the name in `secret`.
// Endpoints and access methods as listed in the community register of UK operators' open-data feeds
// (github.com/osholt/tailendcharlie, docs/ev-charging-open-data-feeds.md). See docs/open-data.md.

export interface OcpiSource {
  kind: "ocpi";
  id: string;
  name: string;
  url: string;
  /** Operator's open-data page, for attribution and to request access. */
  page: string;
  /** Secret holding the key/token; the source is skipped without it. */
  secret?: string;
  /** How the key is sent. */
  header?: string;
  scheme?: "Token" | "Bearer" | "Basic" | "";
}

export interface OcmSource {
  kind: "ocm";
  id: "ocm";
  name: string;
  page: string;
  secret: string;
}

export type SiteSource = OcpiSource | OcmSource;

const ECO = "https://open-chargepoints.com/api/ocpi/cpo/2.2.1/locations/";

/** In priority order: an operator's own feed beats an aggregator's copy of the same site. */
export const SOURCES: SiteSource[] = [
  // Open without a key.
  { kind: "ocpi", id: "geniepoint", name: "GeniePoint", url: "https://opendata.geniepoint.co.uk/locations", page: "https://www.equans.co.uk/drivers-geniepoint/open-data" },
  { kind: "ocpi", id: "mfg", name: "MFG EV Power", url: "https://opendata.motorfuelgroup.net/locations", page: "https://www.motorfuelgroup.com/ev-power/" },
  { kind: "ocpi", id: "evolt", name: "Evolt", url: "https://info.smartcharging.uk/public_feed/locations/3666", page: "https://www.evolt.network/" },
  { kind: "ocpi", id: "cps", name: "ChargePlace Scotland", url: "https://info.smartcharging.uk/public_feed/locations/2463", page: "https://chargeplacescotland.org/" },
  { kind: "ocpi", id: "pogo", name: "PoGo Charge", url: "https://info.smartcharging.uk/public_feed/locations/4009", page: "https://pogocharge.com/" },
  { kind: "ocpi", id: "arnoldclark", name: "Arnold Clark Charge", url: "https://api.fuuse.io/opendata/e6397b95-1624-49cd-824d-ab2f9dfe7294/location", page: "https://www.arnoldclark.com/charge" },
  // Need a free key from the operator.
  { kind: "ocpi", id: "gridserve", name: "GRIDSERVE", url: "https://api.gridserve.com/ocpi/v1/locations", page: "https://www.gridserve.com/open-data/", secret: "OPEN_DATA_GRIDSERVE_KEY", header: "ec-subscription-key", scheme: "" },
  { kind: "ocpi", id: "bppulse", name: "bp pulse", url: ECO, page: "https://www.bppulse.co.uk/help-centre/charging/faq/public-charge-point-regulations", secret: "OPEN_DATA_BP_PULSE_TOKEN", header: "Authorization", scheme: "Token" },
  { kind: "ocpi", id: "ionity", name: "IONITY", url: ECO, page: "https://www.ionity.eu/open-data-request", secret: "OPEN_DATA_IONITY_TOKEN", header: "Authorization", scheme: "Token" },
  { kind: "ocpi", id: "shell", name: "Shell Recharge", url: ECO, page: "https://www.shell.co.uk/electric-vehicle-charging/shell-recharge-open-data-request.html", secret: "OPEN_DATA_SHELL_TOKEN", header: "Authorization", scheme: "Token" },
  { kind: "ocpi", id: "allego", name: "Allego", url: ECO, page: "https://www.allego.eu/charge-point-data/", secret: "OPEN_DATA_ALLEGO_TOKEN", header: "Authorization", scheme: "Token" },
  { kind: "ocpi", id: "fastned", name: "Fastned", url: "https://uk-public.api.fastned.nl/uk-public/ocpi/cpo/2.2.1/locations", page: "https://www.fastnedcharging.com/en-gb/uk-open-data", secret: "OPEN_DATA_FASTNED_KEY", header: "x-api-key", scheme: "" },
  { kind: "ocpi", id: "osprey", name: "Osprey", url: "https://apigw.ospreycharging.co.uk/portal/backend/opendata/ocpi221", page: "https://www.ospreycharging.co.uk/post/consumer-charge-point-regulations", secret: "OPEN_DATA_OSPREY_BASIC", header: "Authorization", scheme: "Basic" },
  // Fills the gaps (free key from openchargemap.org).
  { kind: "ocm", id: "ocm", name: "Open Charge Map", page: "https://openchargemap.org/site/develop/api", secret: "OCM_API_KEY" },
];

export const OCM_URL = "https://api.openchargemap.io/v3/poi/?output=json&countrycode=GB&maxresults=5000&minpowerkw=150&compact=false&verbose=false";

export function attributionFor(s: SiteSource): string {
  return s.kind === "ocm"
    ? "Open Charge Map contributors (CC BY 4.0); records imported from other providers keep their terms"
    : `${s.name} open data, published under the Public Charge Point Regulations 2023`;
}
