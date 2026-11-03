// "Who supplies this depot's electricity?" — one question, four plain answers, and only the details
// the chosen answer needs.
import type { DepotRate, DepotTariff } from "../../shared/energy/depot";
import { OCTOPUS_PRODUCTS, OCTOPUS_REGIONS, REGION_NAMES, type SupplySource } from "../../shared/energy/suppliers";
import { Field, Icon } from "../ui/ui";

const CHOICES: { kind: SupplySource; title: string; text: string }[] = [
  { kind: "octopus", title: "Octopus Energy", text: "Live half-hourly prices, updated automatically" },
  { kind: "wholesale", title: "Wholesale-linked contract", text: "Any supplier: market price plus your fixed costs" },
  { kind: "fixed", title: "Fixed rates", text: "Any supplier: your day, night or peak rates" },
  { kind: "feed", title: "Price feed", text: "Any supplier that publishes prices online" },
];

const WEEKDAYS = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];

export function SupplierPicker({ value, onChange, regionFromPostcode }: { value: DepotTariff; onChange(t: DepotTariff): void; regionFromPostcode: string | null }) {
  const t = value;
  const set = (patch: Partial<DepotTariff>) => onChange({ ...t, ...patch });
  const setRate = (i: number, patch: Partial<DepotRate>) => set({ rates: t.rates.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const preset = OCTOPUS_PRODUCTS.find((p) => p.code === (t.octopus_product ?? ""));
  const custom = t.kind === "octopus" && !preset;
  return (
    <div className="stack gap-12">
      <div className="pick-grid" role="radiogroup" aria-label="Electricity supplier">
        {CHOICES.map((c) => (
          <button key={c.kind} type="button" role="radio" aria-checked={t.kind === c.kind} className="pick"
            onClick={() => set({ kind: c.kind, ...(c.kind === "octopus" && !t.octopus_product ? { octopus_product: "AGILE-BUS-25-02-05", octopus_region: "auto" } : {}), ...(c.kind === "wholesale" && t.uplift == null ? { uplift: 0.12 } : {}) })}>
            <span className="pick-dot" aria-hidden="true" />
            <span><b>{c.title}</b><span className="xs muted">{c.text}</span></span>
          </button>
        ))}
      </div>

      {t.kind === "octopus" && (
        <div className="stack gap-12">
          <Field label="Tariff">{(id) => (
            <select id={id} className="select" value={custom ? "__other" : t.octopus_product} onChange={(e) => set({ octopus_product: e.target.value === "__other" ? "" : e.target.value })}>
              {OCTOPUS_PRODUCTS.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
              <option value="__other">Another Octopus tariff…</option>
            </select>
          )}</Field>
          {custom && <Field label="Octopus product code" hint="As shown on your bill or in Octopus's tariff list, e.g. AGILE-BUS-25-02-05">{(id) => <input id={id} className="input" value={t.octopus_product ?? ""} onChange={(e) => set({ octopus_product: e.target.value.toUpperCase().trim() })} />}</Field>}
          <Field label="Region" hint={t.octopus_region === "auto" || !t.octopus_region ? (regionFromPostcode ? `From your postcode: ${REGION_NAMES[regionFromPostcode]}` : "Worked out from the depot's postcode") : undefined}>{(id) => (
            <select id={id} className="select" value={t.octopus_region ?? "auto"} onChange={(e) => set({ octopus_region: e.target.value })}>
              <option value="auto">From the depot's postcode</option>
              {OCTOPUS_REGIONS.map((r) => <option key={r} value={r}>{REGION_NAMES[r]} ({r})</option>)}
            </select>
          )}</Field>
          <p className="xs muted" style={{ margin: 0 }}>Prices come from Octopus Energy's public tariff data. Tomorrow's half-hourly prices are published at about 4pm; until then, tomorrow is estimated from today's.</p>
        </div>
      )}

      {t.kind === "wholesale" && (
        <div className="stack gap-12">
          <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Your fixed costs, £ per kWh" hint="Networks, levies and your supplier's margin">{(id) => <input id={id} className="input" inputMode="decimal" value={t.uplift ?? 0.12} onChange={(e) => set({ uplift: Number(e.target.value) })} />}</Field>
            <Field label="Fallback rate, £ per kWh" hint="Used if market prices can't be fetched">{(id) => <input id={id} className="input" inputMode="decimal" value={t.standard} onChange={(e) => set({ standard: Number(e.target.value) })} />}</Field>
          </div>
          <p className="xs muted" style={{ margin: 0 }}>The half-hourly market price comes from Elexon's Market Index (free, public). Half-hours not traded yet use the same time on the previous day.</p>
        </div>
      )}

      {t.kind === "fixed" && (
        <div className="stack gap-12">
          <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Supplier (optional)">{(id) => <input id={id} className="input" placeholder="e.g. EDF Energy" value={t.supplier ?? ""} onChange={(e) => set({ supplier: e.target.value })} />}</Field>
            <Field label="All-day rate, £ per kWh">{(id) => <input id={id} className="input" inputMode="decimal" value={t.standard} onChange={(e) => set({ standard: Number(e.target.value) })} />}</Field>
          </div>
          {t.rates.map((r, i) => (
            <div key={i} className="rate-line">
              <input className="input" aria-label="Rate, £ per kWh" inputMode="decimal" value={r.price} onChange={(e) => setRate(i, { price: Number(e.target.value) })} />
              <span className="small muted">from</span>
              <input className="input" aria-label="From" type="time" value={r.start} onChange={(e) => setRate(i, { start: e.target.value })} />
              <span className="small muted">to</span>
              <input className="input" aria-label="To" type="time" value={r.end} onChange={(e) => setRate(i, { end: e.target.value })} />
              <label className="small row gap-4"><input type="checkbox" checked={!!r.days} onChange={(e) => setRate(i, { days: e.target.checked ? WEEKDAYS : undefined })} />Weekdays</label>
              <button type="button" className="btn sm ghost icon-only" aria-label="Remove this rate" onClick={() => set({ rates: t.rates.filter((_, j) => j !== i) })}><Icon name="x" size="sm" /></button>
            </div>
          ))}
          {t.rates.length < 8 && (
            <div className="row gap-8 wrap">
              <button type="button" className="btn sm" onClick={() => set({ rates: [...t.rates, { price: 0.15, start: "00:30", end: "07:30" }] })}><Icon name="plus" size="sm" />Night rate</button>
              <button type="button" className="btn sm" onClick={() => set({ rates: [...t.rates, { price: 0.34, start: "16:00", end: "19:00", days: WEEKDAYS }] })}><Icon name="plus" size="sm" />Evening peak</button>
            </div>
          )}
        </div>
      )}

      {t.kind === "feed" && (
        <div className="stack gap-12">
          <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
            <Field label="Supplier">{(id) => <input id={id} className="input" placeholder="e.g. Smartest Energy" value={t.supplier ?? ""} onChange={(e) => set({ supplier: e.target.value })} />}</Field>
            <Field label="Price feed address" hint={'Returns [{ "start": time, "price": £ per kWh }]'}>{(id) => <input id={id} className="input" placeholder="https://supplier.example/prices.json" value={t.feed_url ?? ""} onChange={(e) => set({ feed_url: e.target.value })} />}</Field>
          </div>
          <Field label="Fallback rate, £ per kWh">{(id) => <input id={id} className="input" inputMode="decimal" style={{ maxWidth: 160 }} value={t.standard} onChange={(e) => set({ standard: Number(e.target.value) })} />}</Field>
        </div>
      )}
    </div>
  );
}
