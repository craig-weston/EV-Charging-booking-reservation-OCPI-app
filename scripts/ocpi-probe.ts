// Read-only check of an operator's OCPI 2.3.0 interface (see docs/operator-testing.md).
//
//   OCPI_TOKEN=<token> npm run ocpi:probe -- https://ocpi.operator.example/versions [--from GB:DPC] [--pages 5] [--json report.json]
//
// The token is read from OCPI_TOKEN so it stays out of your shell history. It is never printed.
import { writeFileSync } from "node:fs";
import { formatReport, probeOperator } from "../server/ocpi/probe";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const json = flag("json");
const from = flag("from");
const pages = flag("pages");
const versionsUrl = args.find((a) => /^https?:\/\//.test(a));
const token = process.env.OCPI_TOKEN;

if (!versionsUrl || !token) {
  console.error("Usage: OCPI_TOKEN=<token> npm run ocpi:probe -- <versions URL> [--from GB:DPC] [--pages 5] [--json report.json]");
  process.exit(2);
}
const [cc, pid] = (from ?? "").split(/[:*-]/);
const report = await probeOperator({
  versionsUrl, token, maxPages: pages ? Number(pages) : undefined,
  from: cc && pid ? { country_code: cc.toUpperCase(), party_id: pid.toUpperCase() } : undefined,
});
console.log(formatReport(report));
if (json) writeFileSync(json, JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
