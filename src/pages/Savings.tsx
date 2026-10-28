// Savings report: fuel cost and CO2e avoided by charging instead of running diesel trucks, from the
// fleet's charge records and stated assumptions. For sustainability reports and board packs.
import { useMemo, useState } from "react";
import type { VehicleType } from "../../shared/ocpi/types";
import { VEHICLE_TYPE_LABEL } from "../../shared/booking/labels";
import { DEFAULT_SAVINGS, cleanAssumptions, computeSavings, savingsCsv, type SavingsAssumptions } from "../../shared/savings";
import { monthPeriod, monthOf, previousMonth } from "../../shared/billing";
import { useApp } from "../app/state";
import { saveFile } from "../app/download";
import { href } from "../app/router";
import { fmtMoney } from "../app/format";
import { Empty, Icon, Plate, Seg, copyText } from "../ui/ui";

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
  const { bookings, vehicles, fleet, fleetId, now, toast } = useApp();
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

  return (
    <div className="page savings">
      <div className="page-head">
        <div>
          <h1>Savings</h1>
          <div className="sub">Fuel and carbon your electric trucks avoided compared with diesel, from your charge records.</div>
        </div>
        <div className="actions">
          <button className="btn" disabled={t.charges === 0} onClick={async () => { if (await copyText(summary)) { setCopied(true); setTimeout(() => setCopied(false), 1800); } }}><Icon name={copied ? "check" : "copy"} size="sm" />{copied ? "Copied" : "Copy summary"}</button>
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
          <section className="kpis" aria-label="Savings">
            <Tile label="CO₂e avoided" value={tonnes(t.co2_saved_kg)} sub={`${N0.format(t.co2_diesel_kg)} kg from diesel, ${N0.format(t.co2_electric_kg)} kg from the grid`} accent />
            {t.cost_saved >= 0
              ? <Tile label="Fuel cost saved" value={fmtMoney(Math.round(t.cost_saved))} sub={`Diesel ${fmtMoney(Math.round(t.diesel_cost))}, charging ${fmtMoney(Math.round(t.electric_cost))} (ex VAT)`} />
              : <Tile label="Extra fuel cost" value={fmtMoney(Math.round(-t.cost_saved))} sub={`Charging ${fmtMoney(Math.round(t.electric_cost))} cost more than diesel would have (${fmtMoney(Math.round(t.diesel_cost))}), ex VAT`} />}
            <Tile label="Diesel avoided" value={`${N0.format(t.diesel_litres)} L`} sub={`At ${fmtMoney(a.diesel_price)} a litre ex VAT`} />
            <Tile label="Electric driving" value={`${N0.format(t.km)} km`} sub={`${N0.format(t.km * 0.621371)} miles from ${N0.format(t.kwh)} kWh, ${t.charges} charges`} />
          </section>

          <section className="panel section">
            <div className="panel-head"><h2>CO₂e avoided per month</h2><span className="right xs muted">Last 12 months, kg</span></div>
            <MonthBars data={year} />
          </section>

          <section className="panel section">
            <div className="panel-head"><h2>By truck</h2></div>
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
          </section>
        </>
      )}

      <section className="panel section">
        <div className="panel-head">
          <h2>How it's worked out</h2>
          <button className="btn sm right" onClick={() => setEditing(!editing)}><Icon name="sliders" size="sm" />{editing ? "Done" : "Change assumptions"}</button>
        </div>
        <div className="panel-body stack gap-12">
          <p className="small">Each charge's energy becomes distance using the truck type's energy use. We then compare it with a diesel truck covering the same distance. Charging costs are what you pay: the operator's price plus the platform margin, before VAT.</p>
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
              <div className="row gap-12 wrap" style={{ alignItems: "center" }}>
                <button className="btn sm ghost" onClick={() => { save(DEFAULT_SAVINGS); setEditing(false); }}>Reset to defaults</button>
                <span className="xs muted">Saved in this browser only.</span>
              </div>
            </div>
          ) : (
            <ul className="savings-facts small">
              <li><b>Diesel price:</b> {fmtMoney(a.diesel_price)} a litre ex VAT. UK pump price reached a record 199p in late September 2026 (RAC); less VAT that's about £1.66. Use your own bulk price if you have one.</li>
              <li><b>Diesel carbon:</b> {a.diesel_kgco2e_per_litre} kg CO₂e per litre (UK government conversion factors 2026, average biofuel blend).</li>
              <li><b>Grid carbon:</b> {a.grid_kgco2e_per_kwh} kg CO₂e per kWh (UK government conversion factors 2026, UK electricity). Renewable-backed charging would be lower; transmission losses aren't included.</li>
              <li><b>Energy use:</b> {TYPES.map((ty) => `${VEHICLE_TYPE_LABEL[ty].toLowerCase()} ${a.kwh_per_km[ty]} kWh/km vs ${a.litres_per_100km[ty]} L/100 km`).join("; ")}. Articulated diesel HGVs average about 7.9 mpg (36 L/100 km).</li>
              <li>Public charging often costs more per mile than diesel today; the gap narrows with depot charging and off-peak tariffs, which aren't included here.</li>
              <li>Only charges booked through this platform are counted, not depot or home charging.{s.defaulted ? ` ${s.defaulted} charges had no truck type, so rigid figures were used.` : ""}</li>
            </ul>
          )}
        </div>
      </section>
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
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`CO2e avoided per month: ${data.map((d) => `${mName(d.month)} ${N0.format(d.kg)} kg`).join(", ")}`}>
        <line x1="0" x2={W} y1={H - PADB} y2={H - PADB} className="mb-axis" />
        {data.map((d, i) => {
          const x = i * bw + bw * 0.22, w = bw * 0.56 - gap, top = y(d.kg), h = H - PADB - top;
          const r = Math.min(4, w / 2, h);
          const path = h > 0 ? `M${x},${H - PADB} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${H - PADB} Z` : "";
          return (
            <g key={d.month} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${mName(d.month, true)}: ${N0.format(d.kg)} kg`}>
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
