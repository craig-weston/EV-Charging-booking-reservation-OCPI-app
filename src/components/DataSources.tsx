// Where the energy data comes from, credited the way each source asks. Quiet by default: one line
// that opens to the details.
const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;

export function DataSources() {
  const year = new Date().getUTCFullYear();
  return (
    <details className="data-sources xs muted">
      <summary>Where the data comes from</summary>
      <ul>
        <li>
          <b>Grid carbon:</b> the {link("https://carbonintensity.org.uk", "Carbon Intensity API")} from the National Energy System Operator (NESO),
          developed in partnership with Environmental Defense Fund Europe, the University of Oxford Department of Computer Science and WWF.
          Regional forecasts up to 48 hours ahead, licensed under {link("https://creativecommons.org/licenses/by/4.0/", "CC BY 4.0")}. Beyond that, a typical day is modelled.
        </li>
        <li><b>Octopus prices:</b> Octopus Energy's {link("https://developer.octopus.energy/rest/", "public tariff data")}, half-hourly where the tariff has it.</li>
        <li>
          <b>Wholesale prices:</b> Market Index Data from Elexon's Insights Solution. Contains BMRS data © Elexon Limited copyright and database right {year}{" "}
          ({link("https://www.elexon.co.uk/data/balancing-mechanism-reporting-agent/copyright-licence-bmrs-data/", "licence")}).
        </li>
        <li>Used under each provider's public terms; no partnership or endorsement is implied.</li>
      </ul>
    </details>
  );
}
