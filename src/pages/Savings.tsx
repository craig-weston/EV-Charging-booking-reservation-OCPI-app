// Savings report: fuel cost and CO2e avoided by charging instead of running diesel trucks, from the
// fleet's charge records and stated assumptions. For sustainability reports and board packs.
import { useMemo, useState } from "react";
import type { VehicleType } from "../../shared/ocpi/types";
import { VEHICLE_TYPE_LABEL } from "../../shared/booking/labels";
import { DataSources } from "../components/DataSources";
import { MoreList, MoreRow } from "../components/More";
import { DEFAULT_SAVINGS, cleanAssumptions, computeSavings, savingsCsv, type SavingsAssumptions } from "../../shared/savings";
import { monthPeriod, monthOf, previousMonth } from "../../shared/billing";
import { useApp } from "../app/state";
import { saveFile } from "../app/download";
import { href } from "../app/router";
import { fmtMoney } from "../app/format";
import { Empty, Icon, Plate, Seg, copyText } from "../ui/ui";
import type { BookingRow } from "../../shared/model";
import { timingReport } from "../../shared/energy/report";
import { findBookingLocation, findLocation, tariffsFor } from "../app/network";
import { useCarbonMany } from "../app/energy";

type Period = "month" | "3m" | "12m" | "all";
const STORE = "depotcharge.savings.v1";
const N0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const N1 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" });
const MONTH_Y = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const mName = (m: string, long = false) => (long ? MONTH_Y : MONTH).format(new Date(`${m}-01T12:00:00Z`));
const tonnes = (kg: number) => (Math.abs(kg) >= 1000 ? `${N1.format(kg / 1000)} t` : `${N0.format(kg)} kg`);
const TYPES: VehicleType[] = ["TRUCK_WITH_TRAILER", "SEMI_TRACTOR", "RIGID", "BUS", "VAN"];

function readAssumptions(fleetId: string | null): SavingsAssumptions {
  try { return cleanAssumptions(JSON.parse(localStorage.getItem(`${STORE}.${fleetId}`) ?? "null")); } catch { return DEFAULT_SAVINGS; }
}

export function SavingsPage() {
  const { bookings, vehicles, fleet, fleetId, now, toast, network } = useApp();
  const [period, setPeriod] = useState<Period>("12m");
  const [a, setA] = useState<SavingsAssumptions>(() => readAssumptions(fleetId));
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  const thisMonth = monthOf(now);
  const range = useMemo(() => {
    if (period === "all") return { from: undefined, to: undefined, label: "All time" };
    const n = period === "month" ? 1 : period === "3m" ? 3 : 12;
    let first = thisMonth;
    for (let i = 1; i < n; i++) first = previousMonth(first);
    return { from: monthPeriod(first).from, to: monthPeriod(thisMonth).to, label: n === 1 ? mName(thisMonth, true) : `${mName(first, true)} to ${mName(thisMonth, true)}` };
  }, [period, thisMonth]);

  const s = useMemo(() => computeSavings(bookings, vehicles, a, { from: range.from, to: range.to, margins: fleet?.margin_history }), [bookings, vehicles, a, range, fleet?.margin_history]);
  // The chart always shows the last 12 months, so a short period still has context.
  const year = useMemo(() => {
    let first = thisMonth;
    for (let i = 1; i < 12; i++) first = previousMonth(first);
    const all = computeSavings(bookings, vehicles, a, { from: monthPeriod(first).from, to: monthPeriod(thisMonth).to, margins: fleet?.margin_history });
    const months: string[] = [];
    for (let m = first, i = 0; i < 12; i++) { months.push(m); m = m.slice(5) === "12" ? `${Number(m.slice(0, 4)) + 1}-01` : `${m.slice(0, 4)}-${String(Number(m.slice(5)) + 1).padStart(2, "0")}`; }
    return months.map((m) => ({ month: m, kg: all.by_month.find((x) => x.month === m)?.co2_saved_kg ?? 0 }));
  }, [bookings, vehicles, a, thisMonth, fleet?.margin_history]);

  // Smart timing: half-hourly grid carbon for each site and month that had charges in the period.
  const postcodeOf = (b: BookingRow) => findLocation(network, b.cpo_country_code, b.cpo_party_id, b.location_id)?.postal_code ?? null;
  const timingKey = (b: BookingRow) => `${postcodeOf(b)}|${b.cdr?.end_date_time.slice(0, 7)}`;
  const timingReq = useMemo(() => {
    const out = new Map<string, { key: string; postcode: string; from: Date; to: Date }>();
    for (const b of bookings) {
      const c = b.cdr, pc = postcodeOf(b);
      if (!c || !pc || !(c.total_energy > 0)) continue;
      const end = new Date(c.end_date_time);
      if ((range.from && end < range.from) || (range.to && end >= range.to)) continue;
      const key = timingKey(b);
      if (out.has(key)) continue;
      const m = c.end_date_time.slice(0, 7);
      const first = new Date(`${m}-01T00:00:00Z`);
      const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
      out.set(key, { key, postcode: pc, from: new Date(first.getTime() - 30 * 3600_000), to: new Date(Math.min(next.getTime() + 30 * 3600_000, now.getTime() + 36 * 3600_000)) });
    }
    return [...out.values()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings, network, range]);
  const carbonMap = useCarbonMany(timingReq);
  const timing = useMemo(() => timingReport(bookings, (b) => carbonMap.get(timingKey(b)) ?? null, (b) => {
    const bl = findBookingLocation(network, b.cpo_country_code, b.cpo_party_id, b.booking_location_id);
    return bl ? tariffsFor(network, bl) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, { from: range.from, to: range.to }), [bookings, carbonMap, network, range]);

  const save = (next: SavingsAssumptions) => {
    const clean = cleanAssumptions(next);
    setA(clean);
    try { localStorage.setItem(`${STORE}.${fleetId}`, JSON.stringify(clean)); } catch { /* this browser only */ }
  };
  const t = s.totals;
  const summary = `${fleet?.name ?? "Our fleet"}, ${range.label}: ${t.charges} charges powered about ${N0.format(t.km)} km of electric HGV driving, avoiding ${N0.format(t.diesel_litres)} litres of diesel and ${tonnes(t.co2_saved_kg)} CO2e${t.cost_saved >= 0 ? `, and saving ${fmtMoney(Math.round(t.cost_saved))} in fuel` : ""}.`;
  const download = async () => {
    try {
      const r = await saveFile(`${(fleet?.name ?? "fleet").replace(/[^\w-]+/g, "-")}-savings-${period}.csv`, savingsCsv(s, a, range.label), "text/csv");
      if (r === "saved") toast("Savings report downloaded");
    } catch (e) { toast(e instanceof Error ? e.message : "Download failed", "bad"); }
  };

  // Each row's one-line summary.
  const diff = timing && timing.dayIntensity > 0 ? (timing.dayIntensity - timing.intensity) / timing.dayIntensity : 0;
  const timingSummary = timing ? [
    `${N0.format(timing.intensity)} g/kWh grid carbon while charging${Math.abs(diff) >= 0.01 ? `, ${N0.format(Math.abs(diff) * 100)}% ${diff > 0 ? "below" : "above"} average` : ""}`,
    timing.touKwh > 0 ? (timing.touSaved >= 0 ? `${fmtMoney(timing.touSaved)} saved off-peak` : `${fmtMoney(-timing.touSaved)} extra at peak times`) : "",
  ].filter(Boolean).join(" · ") : "";
  const top = s.by_vehicle[0];
  const truckSummary = !top ? "" : s.by_vehicle.length === 1 ? `${top.plate}: ${tonnes(top.co2_saved_kg)} CO₂e avoided` : `${s.by_vehicle.length} trucks · ${top.plate} avoided the most, ${tonnes(top.co2_saved_kg)}`;
  const custom = JSON.stringify(a) !== JSON.stringify(DEFAULT_SAVINGS);
  const sourceSummary = custom ? "Using your own figures" : `Diesel at ${fmtMoney(a.diesel_price)} a litre · UK government 2026 carbon factors`;

  return (
    <div className="page savings">
      <div className="page-head">
        <div>
          <h1>Savings</h1>
          <div className="sub">What your electric trucks avoided compared with diesel, from your charge records.</div>
        </div>
        <div className="actions">
          <button className="btn" disabled={t.charges === 0} title={t.charges ? summary : undefined} onClick={async () => { if (await copyText(summary)) { setCopied(true); setTimeout(() => setCopied(false), 1800); } }}><Icon name={copied ? "check" : "copy"} size="sm" />{copied ? "Copied" : "Copy summary"}</button>
          <button className="btn primary" disabled={t.charges === 0} onClick={download}><Icon name="download" size="sm" />Download CSV</button>
        </div>
      </div>

      <div className="row gap-12 wrap" style={{ marginBottom: 16, alignItems: "center" }}>
        <Seg<Period> label="Period" value={period} onChange={setPeriod} options={[{ value: "month", label: "This month" }, { value: "3m", label: "3 months" }, { value: "12m", label: "12 months" }, { value: "all", label: "All time" }]} />
        <span className="small muted">{range.label}</span>
      </div>

      {t.charges === 0 ? (
        <div className="panel"><Empty icon="leaf" title="No charges in this period yet" action={<a className="btn primary" href={href("/book")}>Book a slot</a>}>Savings are worked out from charge records, which operators send after each charge.</Empty></div>
      ) : (
        <>
          <section className="kpis three" aria-label="Savings">
            <Tile label="CO₂e avoided" value={tonnes(t.co2_saved_kg)} sub={`Instead of ${N0.format(t.diesel_litres)} litres of diesel`} accent />
            <Tile label={t.cost_saved >= 0 ? "Fuel cost saved" : "Extra fuel cost"} value={fmtMoney(Math.round(Math.abs(t.cost_saved)))} sub={`Charging ${fmtMoney(Math.round(t.electric_cost))} vs diesel ${fmtMoney(Math.round(t.diesel_cost))}, ex VAT`} />
            <Tile label="Electric driving" value={`${N0.format(t.km)} km`} sub={`${N0.format(t.km * 0.621371)} miles · ${t.charges} charge${t.charges === 1 ? "" : "s"}`} />
          </section>

          <section className="panel section">
            <div className="panel-head"><h2>CO₂e avoided per month</h2><span className="right xs muted">Last 12 months, kg</span></div>
            <MonthBars data={year} />
          </section>
        </>
      )}

      <MoreList label="More about these savings">
        {timing && t.charges > 0 && (
          <MoreRow icon="clock" title="When your trucks charged" summary={timingSummary} tone={diff >= 0.01 ? "ok" : undefined}>
            <TimingBody r={timing} />
          </MoreRow>
        )}
        {top && (
          <MoreRow icon="fleet" title="By truck" summary={truckSummary} flush>
            <div className="table-scroll">
              <table className="stmt-table">
                <thead><tr><th scope="col">Truck</th><th scope="col" className="num">Charges</th><th scope="col" className="num">km (est.)</th><th scope="col" className="num">Diesel avoided</th><th scope="col" className="num">Fuel cost vs diesel</th><th scope="col" className="num">CO₂e avoided</th></tr></thead>
                <tbody>
                  {s.by_vehicle.map((v) => (
                    <tr key={v.vehicle_id ?? v.plate}>
                      <td><Plate plate={v.plate} size="sm" />{v.name && <div className="xs muted">{v.name}</div>}</td>
                      <td className="num">{v.charges}</td>
                      <td className="num">{N0.format(v.km)}</td>
                      <td className="num">{N0.format(v.diesel_litres)} L</td>
                      <td className="num">{v.cost_saved >= 0 ? `${fmtMoney(Math.round(v.cost_saved))} saved` : `${fmtMoney(Math.round(-v.cost_saved))} more`}</td>
                      <td className="num"><b>{tonnes(v.co2_saved_kg)}</b></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </MoreRow>
        )}
        <MoreRow icon="sliders" title="How it's worked out" summary={sourceSummary}>
          <div className="stack gap-12">
            {t.charges > 0 && <p className="small" style={{ margin: 0 }}><b>This period:</b> diesel trucks would have produced {N0.format(t.co2_diesel_kg)} kg CO₂e. The electricity for charging accounted for {N0.format(t.co2_electric_kg)} kg. The difference, {tonnes(t.co2_saved_kg)}, is what you avoided.</p>}
            <p className="small" style={{ margin: 0 }}>Each charge's energy becomes distance using the truck type's energy use, compared with a diesel truck covering the same distance. Charging costs are what you pay: the operator's price plus the platform margin, before VAT.</p>
            {editing ? (
              <div className="savings-edit">
                <label className="field"><span className="label">Diesel price, £ per litre ex VAT</span><input className="input" inputMode="decimal" defaultValue={a.diesel_price} onBlur={(e) => save({ ...a, diesel_price: Number(e.target.value) })} /></label>
                <label className="field"><span className="label">Diesel, kg CO₂e per litre</span><input className="input" inputMode="decimal" defaultValue={a.diesel_kgco2e_per_litre} onBlur={(e) => save({ ...a, diesel_kgco2e_per_litre: Number(e.target.value) })} /></label>
                <label className="field"><span className="label">Grid electricity, kg CO₂e per kWh</span><input className="input" inputMode="decimal" defaultValue={a.grid_kgco2e_per_kwh} onBlur={(e) => save({ ...a, grid_kgco2e_per_kwh: Number(e.target.value) })} /></label>
                <div className="table-scroll savings-types">
                  <table className="stmt-table">
                    <thead><tr><th scope="col">Truck type</th><th scope="col">Electric, kWh per km</th><th scope="col">Diesel, litres per 100 km</th></tr></thead>
                    <tbody>{TYPES.map((ty) => (
                      <tr key={ty}>
                        <th scope="row">{VEHICLE_TYPE_LABEL[ty]}</th>
                        <td><input className="input" inputMode="decimal" aria-label={`${VEHICLE_TYPE_LABEL[ty]} kWh per km`} defaultValue={a.kwh_per_km[ty]} onBlur={(e) => save({ ...a, kwh_per_km: { ...a.kwh_per_km, [ty]: Number(e.target.value) } })} /></td>
                        <td><input className="input" inputMode="decimal" aria-label={`${VEHICLE_TYPE_LABEL[ty]} litres per 100 km`} defaultValue={a.litres_per_100km[ty]} onBlur={(e) => save({ ...a, litres_per_100km: { ...a.litres_per_100km, [ty]: Number(e.target.value) } })} /></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </div>
            ) : (
              <ul className="savings-facts small">
                <li><b>Diesel price:</b> {fmtMoney(a.diesel_price)} a litre ex VAT.{a.diesel_price === DEFAULT_SAVINGS.diesel_price ? " That's the record 199p UK pump price of late September 2026 (RAC), less VAT." : ""} Use your own bulk price if you have one.</li>
                <li><b>Carbon:</b> diesel {a.diesel_kgco2e_per_litre} kg CO₂e per litre (average biofuel blend) and grid electricity {a.grid_kgco2e_per_kwh} kg CO₂e per kWh, the UK government's 2026 conversion factors that carbon reports expect. Renewable-backed charging would be lower; transmission losses aren't included.</li>
                <li><b>Energy use:</b> {TYPES.map((ty) => `${VEHICLE_TYPE_LABEL[ty].toLowerCase()} ${a.kwh_per_km[ty]} kWh/km vs ${a.litres_per_100km[ty]} L/100 km`).join("; ")}. Articulated diesel HGVs average about 7.9 mpg (36 L/100 km).</li>
                <li><b>Charging times:</b> half-hourly regional grid carbon from the Carbon Intensity API (NESO, developed with Environmental Defense Fund Europe, the University of Oxford and WWF){timing?.modelled ? ", modelled where its data wasn't available," : ""} and each operator's time-of-use rates.</li>
                <li>Only charges booked through this platform count, not depot or home charging.{s.defaulted ? ` ${s.defaulted} charges had no truck type, so rigid figures were used.` : ""} Public charging often costs more per mile than diesel today; depot charging and off-peak tariffs narrow the gap.</li>
              </ul>
            )}
            <div className="row gap-8 wrap" style={{ alignItems: "center" }}>
              <button className="btn sm" onClick={() => setEditing(!editing)}><Icon name={editing ? "check" : "sliders"} size="sm" />{editing ? "Done" : "Change assumptions"}</button>
              {(editing || custom) && <button className="btn sm ghost" onClick={() => { save(DEFAULT_SAVINGS); setEditing(false); }}>Reset to defaults</button>}
              {editing && <span className="xs muted">Saved in this browser only.</span>}
            </div>
            {!editing && <DataSources />}
          </div>
        </MoreRow>
      </MoreList>
    </div>
  );
}

function TimingBody({ r }: { r: NonNullable<ReturnType<typeof timingReport>> }) {
  const diff = r.dayIntensity > 0 ? (r.dayIntensity - r.intensity) / r.dayIntensity : 0;
  return (
    <div className="stack gap-16">
      <div className="figures">
        <div><b>{N0.format(r.intensity)} g/kWh</b><span>Grid carbon while charging, {Math.abs(diff) < 0.01 ? `about the same as those days' ${N0.format(r.dayIntensity)} g/kWh average` : `${N0.format(Math.abs(diff) * 100)}% ${diff > 0 ? "below" : "above"} those days' ${N0.format(r.dayIntensity)} g/kWh average`}</span></div>
        <div><b>{tonnes(Math.abs(r.kgByTiming))}</b><span>{r.kgByTiming >= 0 ? "CO₂ avoided by timing" : "Extra CO₂ from timing"}, compared with charging at each day's average</span></div>
        <div><b>{fmtMoney(Math.abs(r.touSaved))}</b><span>{r.touKwh > 0 ? `${r.touSaved >= 0 ? "Saved on off-peak rates" : "Extra at peak-time rates"}, ${N0.format(r.touKwh)} kWh on time-of-use prices, ex VAT` : "No charges used a time-of-use rate"}</span></div>
        <div><b>{tonnes(r.kgOpportunity)}</b><span>Still on the table, if each charge had moved up to 3 hours to its cleanest window</span></div>
      </div>
      <div>
        <h3 className="small" style={{ margin: "0 0 4px" }}>Share of charging energy by hour of day</h3>
        <HourBars share={r.byHour} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>Book with the <b>Greenest</b> and <b>Cheapest</b> suggestions to move more charging into clean, low-price hours.{r.modelled ? " Grid carbon here is modelled." : ""}</p>
    </div>
  );
}

/** Share of kWh by hour of day: one series of thin bars with a tooltip. */
function HourBars({ share }: { share: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 120, PADB = 22, PADT = 18;
  const max = Math.max(0.0001, ...share);
  const bw = W / 24;
  const y = (v: number) => H - PADB - (v / max) * (H - PADB - PADT);
  const peak = share.reduce((best, v, i) => (v > share[best] ? i : best), 0);
  const hh = (i: number) => String(i).padStart(2, "0");
  return (
    <div className="month-bars">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`Share of charging energy by hour: ${share.map((v, i) => `${hh(i)}:00 ${Math.round(v * 100)}%`).join(", ")}`}>
        <line x1="0" x2={W} y1={H - PADB} y2={H - PADB} className="mb-axis" />
        {share.map((v, i) => {
          const x = i * bw + bw * 0.18, w = bw * 0.64 - 2, top = y(v), h = H - PADB - top;
          const r = Math.min(4, w / 2, h);
          const path = h > 0.5 ? `M${x},${H - PADB} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - PADB} Z` : "";
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} role="img" aria-label={`${hh(i)}:00 to ${hh((i + 1) % 24)}:00: ${Math.round(v * 100)}% of energy`}>
              <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
              {path && <path d={path} className={`mb-bar ${hover === i ? "on" : ""}`} />}
              {i === peak && v > 0 && <text x={x + w / 2} y={top - 5} textAnchor="middle" className="mb-val">{Math.round(v * 100)}%</text>}
              {i % 3 === 0 && <text x={i * bw + bw / 2} y={H - 6} textAnchor="middle" className="mb-x">{hh(i)}</text>}
            </g>
          );
        })}
      </svg>
      {hover != null && <div className="mb-tip" style={{ left: `${((hover + 0.5) / 24) * 100}%` }}><b>{hh(hover)}:00 to {hh((hover + 1) % 24)}:00</b><span>{Math.round(share[hover] * 100)}% of charging energy</span></div>}
    </div>
  );
}

function Tile({ label, value, sub, accent }: { label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <div className={`kpi ${accent ? "kpi-accent" : ""}`}>
      <div className="kpi-label">{accent && <Icon name="leaf" size="sm" />}{label}</div>
      <div className="kpi-value">{value}</div>
      <div className="xs muted">{sub}</div>
    </div>
  );
}

/** One series of monthly bars: thin marks, rounded tops on a baseline, a label on the latest
 *  and the largest month, and a tooltip on hover or focus. */
function MonthBars({ data }: { data: { month: string; kg: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 150, PADB = 26, PADT = 22, gap = 2;
  const max = Math.max(1, ...data.map((d) => d.kg));
  const bw = W / data.length;
  const y = (v: number) => H - PADB - (Math.max(0, v) / max) * (H - PADB - PADT);
  const peak = data.reduce((best, d, i) => (d.kg > data[best].kg ? i : best), 0);
  const last = data.length - 1;
  return (
    <div className="month-bars">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`CO2e avoided per month: ${data.map((d) => `${mName(d.month)} ${N0.format(d.kg)} kg`).join(", ")}`}>
        <line x1="0" x2={W} y1={H - PADB} y2={H - PADB} className="mb-axis" />
        {data.map((d, i) => {
          const x = i * bw + bw * 0.22, w = bw * 0.56 - gap, top = y(d.kg), h = H - PADB - top;
          const r = Math.min(4, w / 2, h);
          const path = h > 0 ? `M${x},${H - PADB} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - PADB} Z` : "";
          return (
            <g key={d.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} role="img" aria-label={`${mName(d.month, true)}: ${N0.format(d.kg)} kg`}>
              <rect x={i * bw} y={PADT - 10} width={bw} height={H - PADT + 10} fill="transparent" />
              {path && <path d={path} className={`mb-bar ${hover === i ? "on" : ""}`} />}
              {(i === peak || i === last) && d.kg > 0 && <text x={x + w / 2} y={top - 6} textAnchor="middle" className="mb-val">{N0.format(d.kg)}</text>}
              <text x={i * bw + bw / 2} y={H - 8} textAnchor="middle" className="mb-x">{mName(d.month)}</text>
            </g>
          );
        })}
      </svg>
      {hover != null && <div className="mb-tip" style={{ left: `${((hover + 0.5) / data.length) * 100}%` }}><b>{mName(data[hover].month, true)}</b><span>{N0.format(data[hover].kg)} kg CO₂e avoided</span></div>}
    </div>
  );
}
