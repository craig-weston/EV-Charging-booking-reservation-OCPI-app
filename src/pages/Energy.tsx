// Depot charging: the fleet's own depots, the trucks staying overnight, and a plan that charges
// each one in the cheapest, cleanest half-hours that still get it full before it leaves, without
// going over the site's grid connection. Schedules are sent to the chargers over OCPP.
import { useCallback, useEffect, useRef, useState } from "react";
import type { DepotDispatch, EnergyState } from "../../shared/model";
import { cleanEnergy, newDepot, type Depot, type DepotGoal, type DepotRate, type DepotVisit, type EnergyConfig } from "../../shared/energy/depot";
import { carbonBand } from "../../shared/energy/carbon";
import { PROGRAMME_LABEL, type FlexEvent, type FlexProgramme } from "../../shared/energy/flex";
import type { DepotPlanView } from "../../server/depot";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtDay, fmtMoney, fmtTime } from "../app/format";
import { localToUtc, localDateKey, uuid } from "../../shared/util";
import { Drawer, Empty, Field, Icon, Plate, Seg, Spinner, Switch } from "../ui/ui";

type EnergyView = { config: EnergyConfig; state: EnergyState; has_secret: Record<string, boolean> };
type PlanResponse = DepotPlanView & { dispatch: DepotDispatch | null };

const N0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const TZ = "Europe/London";
const GOALS: { value: DepotGoal; label: string; hint: string }[] = [
  { value: "cost", label: "Lowest cost", hint: "Cheapest half-hours, whatever the carbon." },
  { value: "balanced", label: "Balanced", hint: "Cheap first, and cleaner when prices are close (carbon valued at £100 a tonne)." },
  { value: "carbon", label: "Lowest carbon", hint: "Cleanest half-hours, accepting a little extra cost." },
];
const CONTROL_LABEL = { simulated: "Simulated (not connected yet)", citrineos: "CitrineOS", webhook: "Depot operator's system" } as const;

export function EnergyPage() {
  const { api, fleetId, me, vehicles, now, toast } = useApp();
  const role = me?.memberships.find((m) => m.fleet_id === fleetId)?.role;
  const canPlan = role === "owner" || role === "planner";
  const [energy, setEnergy] = useState<EnergyView | null>(null);
  const [depotId, setDepotId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [visits, setVisits] = useState<DepotVisit[]>([]);
  const [flex, setFlex] = useState<FlexEvent[]>([]);
  const [editVisit, setEditVisit] = useState<DepotVisit | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!fleetId) return;
    try {
      const [e, v, f] = await Promise.all([api<EnergyView>("GET", `/fleets/${fleetId}/energy`), api<DepotVisit[]>("GET", `/fleets/${fleetId}/depot-visits`), api<FlexEvent[]>("GET", `/fleets/${fleetId}/flex/events`).catch(() => [] as FlexEvent[])]);
      setEnergy(e); setVisits(v); setFlex(f);
      const id = depotId && e.config.depots.some((d) => d.id === depotId) ? depotId : e.config.depots[0]?.id ?? null;
      setDepotId(id);
      if (id) setPlan(await api<PlanResponse>("GET", `/fleets/${fleetId}/depots/${encodeURIComponent(id)}/plan`));
      else setPlan(null);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't load depot smart charging");
    }
  }, [api, fleetId, depotId]);
  useEffect(() => { void load(); }, [load]);
  // Re-plan every few minutes as time moves on.
  useEffect(() => { const t = setInterval(() => void load(), 5 * 60_000); return () => clearInterval(t); }, [load]);

  const depot = energy?.config.depots.find((d) => d.id === depotId) ?? null;

  const send = async () => {
    if (!depot || !fleetId) return;
    setSending(true);
    try {
      const d = await api<DepotDispatch>("POST", `/fleets/${fleetId}/depots/${encodeURIComponent(depot.id)}/dispatch`);
      toast(d.ok ? `Schedules sent to ${d.results.length} charger${d.results.length === 1 ? "" : "s"}` : "Some chargers didn't accept the schedule", d.ok ? undefined : "bad");
      await load();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't send schedules", "bad");
    } finally { setSending(false); }
  };

  if (!energy) {
    return <div className="page"><div className="page-head"><h1>Depot smart charging</h1></div>{error ? <div className="panel panel-body error-text">{error}</div> : <div className="panel panel-body"><Spinner label="Loading" /></div>}</div>;
  }

  return (
    <div className="page energy">
      <div className="page-head">
        <div>
          <h1>Depot smart charging</h1>
          <div className="sub">Every truck charged in the cheapest, cleanest half-hours that still get it full before it leaves, within your grid connection.</div>
        </div>
        <div className="actions">
          {energy.config.depots.length > 1 && (
            <select className="select" aria-label="Depot" value={depotId ?? ""} onChange={(e) => setDepotId(e.target.value)}>
              {energy.config.depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          {role === "owner" && <button className="btn" onClick={() => setSettingsOpen(true)}><Icon name="sliders" size="sm" />{depot ? "Depot settings" : "Set up a depot"}</button>}
          {depot && canPlan && <button className="btn primary" onClick={() => setEditVisit("new")}><Icon name="plus" size="sm" />Add truck</button>}
        </div>
      </div>

      {!depot ? (
        <div className="panel"><Empty icon="warehouse" title="Set up your depot" action={role === "owner" ? <button className="btn primary" onClick={() => setSettingsOpen(true)}>Set up a depot</button> : undefined}>
          Add your depot's chargers, grid connection and electricity tariff. Then tell us when trucks arrive and leave, and how much charge they need: we'll plan the cheapest, cleanest way to have every one ready on time.
        </Empty></div>
      ) : !plan ? <div className="panel panel-body"><Spinner label="Planning" /></div> : (
        <>
          <PlanKpis plan={plan} depot={depot} />
          <section className="panel section">
            <div className="panel-head">
              <h2>Charging plan</h2>
              <span className="right xs muted">{plan.price_source === "agile" ? "Octopus Agile prices" : plan.price_source === "agile-modelled" ? "Modelled dynamic prices" : "Your tariff"}, {plan.carbon_source === "neso" ? "NESO carbon forecast" : plan.carbon_source === "mixed" ? "NESO forecast, modelled beyond 48 h" : "modelled grid carbon"}</span>
            </div>
            <div className="panel-body">
              {plan.visits.length ? <LoadChart plan={plan} now={now} /> : <p className="muted small" style={{ margin: 0 }}>No trucks due at this depot in the next three days.</p>}
            </div>
          </section>
          <section className="panel section">
            <div className="panel-head"><h2>Trucks</h2><span className="right xs muted">{depot.chargers.length} charger{depot.chargers.length === 1 ? "" : "s"}, plan from now</span></div>
            <TruckList plan={plan} depot={depot} now={now} canEdit={canPlan} onEdit={(v) => setEditVisit(v)} />
          </section>
          <V2gPanel depot={depot} plan={plan} vehicles={vehicles} isOwner={role === "owner"} onSettings={() => setSettingsOpen(true)} />
          <FlexPanel depot={depot} events={flex.filter((x) => x.depot_id === depot.id)} provider={energy.config.flex_provider} now={now} canDecide={canPlan} isOwner={role === "owner"} onSettings={() => setSettingsOpen(true)} onChanged={load} />
          <DispatchPanel depot={depot} plan={plan} canSend={canPlan} sending={sending} onSend={send} isOwner={role === "owner"} onSettings={() => setSettingsOpen(true)} />
        </>
      )}

      {editVisit && depot && (
        <VisitDrawer depot={depot} visit={editVisit === "new" ? null : editVisit} vehicles={vehicles} now={now} onClose={() => setEditVisit(null)}
          onSaved={async () => { setEditVisit(null); await load(); }} existing={visits} />
      )}
      {settingsOpen && (
        <DepotSettings energy={energy} depotId={depotId} onClose={() => setSettingsOpen(false)} onSaved={async (e, id) => { setEnergy(e); setDepotId(id); setSettingsOpen(false); await load(); }} />
      )}
    </div>
  );
}

function PlanKpis({ plan, depot }: { plan: PlanResponse; depot: Depot }) {
  const ready = plan.visits.filter((v) => v.outcome !== "short").length;
  const saved = plan.baseline.cost - plan.cost;
  const kgCut = plan.baseline.kg > 0 ? (plan.baseline.kg - plan.kg) / plan.baseline.kg : 0;
  const short = plan.visits.filter((v) => v.outcome === "short");
  return (
    <section className="kpis" aria-label="Plan summary">
      <div className="kpi kpi-accent">
        <div className="kpi-label"><Icon name="poundSterling" size="sm" />Energy cost</div>
        <div className="kpi-value">{fmtMoney(plan.cost)}</div>
        <div className="xs muted">{saved >= 0.5 ? `${fmtMoney(saved)} less than charging on arrival` : "Same as charging on arrival"}, ex VAT</div>
      </div>
      <div className="kpi">
        <div className="kpi-label"><Icon name="leaf" size="sm" />Grid CO₂</div>
        <div className="kpi-value">{N0.format(plan.kg)} kg</div>
        <div className="xs muted">{kgCut >= 0.01 ? `${N0.format(kgCut * 100)}% lower than charging on arrival` : "About the same as charging on arrival"}</div>
      </div>
      <div className="kpi">
        <div className="kpi-label"><Icon name="gauge" size="sm" />Peak load</div>
        <div className="kpi-value">{N0.format(plan.peak_kw)} kW</div>
        <div className="xs muted">of {N0.format(plan.headroom_kw)} kW for charging ({N0.format(depot.import_limit_kw)} kW connection, {N0.format(depot.site_load_kw)} kW kept for the site)</div>
      </div>
      <div className={`kpi ${short.length ? "kpi-warn" : ""}`}>
        <div className="kpi-label"><Icon name={short.length ? "alert" : "circleCheck"} size="sm" />Ready on time</div>
        <div className="kpi-value">{ready} of {plan.visits.length}</div>
        <div className="xs muted">{short.length ? `${short.map((s) => s.plate).join(", ")} can't be filled in time` : plan.visits.length ? "Every truck full before it leaves" : "No trucks due"}</div>
      </div>
    </section>
  );
}

const SERIES = 8;

/** Planned kW per half-hour, stacked by truck, against the charging headroom, with price below. */
function LoadChart({ plan, now }: { plan: PlanResponse; now: Date }) {
  const [hover, setHover] = useState<number | null>(null);
  const S = plan.slots.length;
  const W = Math.max(720, S * 14), H = 220, PADB = 24, PADT = 16, STRIP = 12;
  const max = Math.max(plan.headroom_kw, plan.peak_kw, 1) * 1.08;
  const give = plan.slots.map((_, j) => plan.visits.reduce((a, v) => a + Math.min(0, v.plan.kw[j] ?? 0), 0));
  const min = Math.min(0, ...give) * 1.15;
  const bw = W / S;
  const y = (kw: number) => H - PADB - STRIP - 6 - ((kw - min) / (max - min)) * (H - PADB - STRIP - 6 - PADT);
  const base = y(0);
  const prices = plan.slots.map((s) => s.price);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const order = plan.visits.map((_, i) => i);
  const ticks = plan.slots.map((s, j) => ({ j, d: new Date(s.start) })).filter(({ d }) => d.getUTCMinutes() === 0 && Number(fmtTime(d, TZ).slice(0, 2)) % 3 === 0);
  const h = hover != null ? plan.slots[hover] : null;
  // On narrow screens the chart scrolls: start it at the first planned charging.
  const scroller = useRef<HTMLDivElement>(null);
  const first = plan.total_kw.findIndex((kw) => kw >= 0.05);
  useEffect(() => {
    const el = scroller.current;
    if (!el || first < 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, (first / S) * el.scrollWidth - 24);
  }, [first, S]);
  return (
    <div className="load-chart">
      <div className="lc-legend" aria-hidden="true">
        {plan.visits.map((v, i) => <span key={v.visit.id}><i className={`sw s${(i % SERIES) + 1}`} />{v.plate}</span>)}
        <span><i className="sw limit" />Charging limit</span>
        {(plan.events ?? []).length > 0 && <span><i className="sw ev-down" />Grid event</span>}
        {give.some((g) => g < -0.05) && <span><i className="sw give" />Giving power back (V2G)</span>}
      </div>
      <div className="lc-scroll" ref={scroller}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: Math.max(620, W > 900 ? W * 0.9 : 0) }} role="group" aria-label={`Planned charging power by half-hour, peak ${N0.format(plan.peak_kw)} kW against a ${N0.format(plan.headroom_kw)} kW limit`}>
          {(plan.events ?? []).map((e) => {
            const t0 = plan.slots[0]?.start ?? 0, t1 = plan.slots[S - 1]?.end ?? 1;
            const a = Math.max(t0, Date.parse(e.start_at)), b = Math.min(t1, Date.parse(e.end_at));
            if (b <= a) return null;
            const x0 = ((a - t0) / (t1 - t0)) * W, x1 = ((b - t0) / (t1 - t0)) * W;
            return (
              <g key={e.id} className={`lc-event ${e.direction} ${e.status}`}>
                <rect x={x0} y={PADT - 10} width={x1 - x0} height={base - PADT + 10} />
                <text x={x0 + 4} y={PADT + 2} className="mb-x">{e.direction === "down" ? "Turn down" : "Turn up"}{e.status === "offered" ? "?" : ""}</text>
              </g>
            );
          })}
          <line x1="0" x2={W} y1={base} y2={base} className="mb-axis" />
          {plan.slots.map((s, j) => {
            let acc = 0;
            const x = j * bw + 1, w = Math.max(1, bw - 2);
            return (
              <g key={s.start} onMouseEnter={() => setHover(j)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(j)} onBlur={() => setHover(null)} tabIndex={0} role="img"
                aria-label={`${fmtTime(new Date(s.start), TZ)}: ${N0.format(plan.total_kw[j])} kW, ${fmtMoney(s.price)} per kWh${s.carbon != null ? `, ${s.carbon} g CO2 per kWh` : ""}`}>
                <rect x={j * bw} y={0} width={bw} height={H} fill="transparent" />
                {(() => { let neg = 0; return order.map((i) => {
                  const kw = plan.visits[i].plan.kw[j] ?? 0;
                  if (kw > -0.05) return null;
                  const top = y(neg), bottom = y(neg + kw);
                  neg += kw;
                  return <rect key={`g${i}`} x={x} y={top} width={w} height={Math.max(0, bottom - top)} rx={1.5} className={`seg give s${(i % SERIES) + 1}`} />;
                }); })()}
                {order.map((i) => {
                  const kw = plan.visits[i].plan.kw[j] ?? 0;
                  if (kw < 0.05) return null;
                  const top = y(acc + kw), bottom = y(acc);
                  acc += kw;
                  return <rect key={i} x={x} y={top} width={w} height={Math.max(0, bottom - top - (acc > kw ? 1 : 0))} rx={1.5} className={`seg s${(i % SERIES) + 1} ${hover === j ? "on" : ""}`} />;
                })}
                <rect x={j * bw} y={H - PADB - STRIP + 2} width={bw} height={STRIP - 2} className="price-cell" style={{ opacity: hi > lo ? 0.12 + 0.78 * (1 - (s.price - lo) / (hi - lo)) : 0.4 }} />
              </g>
            );
          })}
          <line x1="0" x2={W} y1={y(plan.headroom_kw)} y2={y(plan.headroom_kw)} className="lc-limit" />
          <text x={W - 4} y={y(plan.headroom_kw) - 5} textAnchor="end" className="mb-val">{N0.format(plan.headroom_kw)} kW limit</text>
          {ticks.map(({ j, d }) => <text key={j} x={j * bw + 2} y={H - 6} className="mb-x" textAnchor="start">{fmtTime(d, TZ) === "00:00" ? fmtDay(d, now, TZ).replace("Tomorrow", "Tmrw") : fmtTime(d, TZ)}</text>)}
        </svg>
      </div>
      <div className="lc-foot xs muted"><span className="price-key" aria-hidden="true" />Strip: electricity price, darker is cheaper. {fmtMoney(lo)} to {fmtMoney(hi)} per kWh.</div>
      {h && hover != null && (
        <div className="mb-tip lc-tip" style={{ left: `${((hover + 0.5) / S) * 100}%` }}>
          <b>{fmtTime(new Date(h.start), TZ)}–{fmtTime(new Date(h.end), TZ)}</b>
          <span>{N0.format(plan.total_kw[hover])} kW {plan.total_kw[hover] < 0 ? "net export" : "planned"} · {fmtMoney(h.price)}/kWh{h.carbon != null ? ` · ${h.carbon} g CO₂ (${carbonBand(h.carbon).label.toLowerCase()})` : ""}</span>
          {plan.visits.filter((v) => Math.abs(v.plan.kw[hover] ?? 0) >= 0.05).map((v) => <span key={v.visit.id}>{v.plate}: {(v.plan.kw[hover] ?? 0) < 0 ? `giving back ${N0.format(-v.plan.kw[hover])} kW` : `${N0.format(v.plan.kw[hover])} kW`}</span>)}
        </div>
      )}
    </div>
  );
}

function TruckList({ plan, depot, now, canEdit, onEdit }: { plan: PlanResponse; depot: Depot; now: Date; canEdit: boolean; onEdit(v: DepotVisit): void }) {
  if (!plan.visits.length) return <div className="panel-body"><p className="muted small" style={{ margin: 0 }}>Add the trucks staying at this depot: when they arrive, when they leave and the charge they need.</p></div>;
  const S = plan.slots.length;
  return (
    <ul className="truck-plan">
      {plan.visits.map((v, i) => {
        const ch = depot.chargers.find((c) => c.id === v.visit.charger_id);
        const arrive = new Date(v.visit.arrive_at), depart = new Date(v.visit.depart_at);
        return (
          <li key={v.visit.id}>
            <div className="tp-id">
              <i className={`sw s${(i % SERIES) + 1}`} aria-hidden="true" />
              <div>
                <Plate plate={v.plate} size="sm" />
                <div className="xs muted">{v.name ?? ""}{ch ? ` · ${ch.name}` : " · no charger set"}</div>
              </div>
            </div>
            <div className="tp-when small">
              <div><span className="muted">Arrives</span> {arrive < now ? "here now" : `${fmtDay(arrive, now, TZ)} ${fmtTime(arrive, TZ)}`}</div>
              <div><span className="muted">Leaves</span> {fmtDay(depart, now, TZ)} {fmtTime(depart, TZ)}</div>
            </div>
            <div className="tp-soc">
              <div className="small"><b>{v.visit.soc_start}%</b> → <b>{v.soc_ready}%</b>{v.soc_ready < v.visit.soc_target ? <span className="muted"> of {v.visit.soc_target}%</span> : null}</div>
              <div className="tp-bar" aria-hidden="true"><span className="from" style={{ width: `${v.visit.soc_start}%` }} /><span className="add" style={{ left: `${v.visit.soc_start}%`, width: `${Math.max(0, v.soc_ready - v.visit.soc_start)}%` }} /><i style={{ left: `${v.visit.soc_target}%` }} /></div>
              <div className="xs muted">{v.battery_kwh ? `${N0.format(v.need_kwh)} kWh from the grid, up to ${N0.format(v.max_kw)} kW` : "Add the battery size in Fleet to plan this truck"}</div>
            </div>
            <div className="tp-mini" aria-hidden="true">
              {v.plan.kw.map((kw, j) => kw >= 0.05 ? <span key={j} className={`s${(i % SERIES) + 1}`} style={{ left: `${(j / S) * 100}%`, width: `${100 / S}%`, opacity: 0.35 + 0.65 * Math.min(1, kw / Math.max(1, v.max_kw)) }} /> : kw <= -0.05 ? <span key={j} className={`give s${(i % SERIES) + 1}`} style={{ left: `${(j / S) * 100}%`, width: `${100 / S}%` }} /> : null)}
            </div>
            <div className="tp-status">
              {v.outcome === "ready" && <span className="tag ok"><Icon name="circleCheck" size="sm" />Ready by {v.plan.readyAt ? fmtTime(new Date(v.plan.readyAt), TZ) : "—"}</span>}
              {v.outcome === "short" && <span className="tag bad"><Icon name="alert" size="sm" />{N0.format(v.plan.shortfallKwh)} kWh short</span>}
              {v.outcome === "idle" && <span className="tag">{v.battery_kwh ? "Already charged" : "Battery size missing"}</span>}
              {(() => { const back = v.plan.kw.reduce((a, kw, j) => a + (kw < 0 ? -kw * ((plan.slots[j].end - plan.slots[j].start) / 3_600_000) : 0), 0); return back > 0.5 ? <span className="tag v2g"><Icon name="arrowUpRight" size="sm" />Gives back {N0.format(back)} kWh</span> : null; })()}
              <span className="xs muted">{v.plan.cost < 0 ? `earns ${fmtMoney(-v.plan.cost)}` : fmtMoney(v.plan.cost)} · {N0.format(v.plan.kg)} kg CO₂</span>
            </div>
            {canEdit && <button className="btn sm ghost tp-edit" onClick={() => onEdit(v.visit)} aria-label={`Edit ${v.plate}`}><Icon name="pencil" size="sm" /></button>}
          </li>
        );
      })}
    </ul>
  );
}

function DispatchPanel({ depot, plan, canSend, sending, onSend, isOwner, onSettings }: { depot: Depot; plan: PlanResponse; canSend: boolean; sending: boolean; onSend(): void; isOwner: boolean; onSettings(): void }) {
  const d = plan.dispatch;
  const name = (id: string) => depot.chargers.find((c) => c.id === id)?.name ?? id;
  return (
    <section className="panel section">
      <div className="panel-head">
        <h2>Chargers</h2>
        <span className="right row gap-8">
          <span className="tag">{CONTROL_LABEL[depot.control.kind]}</span>
          {canSend && <button className="btn sm primary" disabled={sending || !plan.visits.length} onClick={onSend}>{sending ? <Spinner label="Sending" /> : <Icon name="zap" size="sm" />}Send to chargers</button>}
        </span>
      </div>
      <div className="panel-body stack gap-12">
        <p className="small" style={{ margin: 0 }}>
          {depot.control.kind === "simulated"
            ? <>Schedules are worked out and recorded, but not sent anywhere yet. {isOwner ? <>Connect your chargers in <button className="linklike" onClick={onSettings}>depot settings</button>: through CitrineOS (free, open source) or your depot operator's system.</> : "Ask a fleet owner to connect the chargers."}</>
            : <>Each charger gets an OCPP 2.0.1 charging profile with its power limit for every half-hour. Profiles end at the last departure, so chargers fall back to their own settings if the connection is lost.{depot.auto_dispatch ? " Plans are re-sent automatically every 15 minutes." : ""}</>}
        </p>
        {d ? (
          <div className="stack gap-6">
            <div className="xs muted">Last sent {new Date(d.at).toLocaleString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })} ({d.by === "auto" ? "automatically" : "by hand"})</div>
            <ul className="dispatch-list">
              {d.results.map((r) => <li key={r.charger_id}><Icon name={r.ok ? "circleCheck" : "circleX"} size="sm" /><b>{name(r.charger_id)}</b><span className="muted small">{r.message}</span></li>)}
            </ul>
          </div>
        ) : <div className="xs muted">No schedules sent yet.</div>}
      </div>
    </section>
  );
}

// ---- add / edit a truck's depot visit -------------------------------------------------------

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const k = localDateKey(d, TZ);
  return `${k}T${fmtTime(d, TZ)}`;
};
const fromLocalInput = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  return m ? localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], TZ).toISOString() : "";
};

function VisitDrawer({ depot, visit, vehicles, now, onClose, onSaved, existing }: {
  depot: Depot; visit: DepotVisit | null; vehicles: { id: string; name: string; plate: string; battery_kwh: number | null }[]; now: Date;
  onClose(): void; onSaved(): void; existing: DepotVisit[];
}) {
  const { api, fleetId, toast } = useApp();
  const tonight = new Date(now); tonight.setHours(18, 0, 0, 0);
  const morning = new Date(tonight.getTime() + 11 * 3_600_000);
  const [f, setF] = useState(() => ({
    vehicle_id: visit?.vehicle_id ?? vehicles[0]?.id ?? "",
    charger_id: visit?.charger_id ?? depot.chargers.find((c) => !existing.some((v) => v.charger_id === c.id && v.status !== "done" && v.status !== "cancelled" && new Date(v.depart_at) > now))?.id ?? depot.chargers[0]?.id ?? "",
    arrive: toLocalInput(visit?.arrive_at ?? (tonight > now ? tonight : now).toISOString()),
    depart: toLocalInput(visit?.depart_at ?? morning.toISOString()),
    soc_start: visit?.soc_start ?? 30,
    soc_target: visit?.soc_target ?? 90,
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const veh = vehicles.find((v) => v.id === f.vehicle_id);
  const kwh = veh?.battery_kwh ? Math.max(0, ((f.soc_target - f.soc_start) / 100) * veh.battery_kwh) : null;

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { depot_id: depot.id, vehicle_id: f.vehicle_id, charger_id: f.charger_id || null, arrive_at: fromLocalInput(f.arrive), depart_at: fromLocalInput(f.depart), soc_start: f.soc_start, soc_target: f.soc_target };
      if (visit) await api("PATCH", `/fleets/${fleetId}/depot-visits/${visit.id}`, body);
      else await api("POST", `/fleets/${fleetId}/depot-visits`, body);
      toast(visit ? "Truck updated, plan refreshed" : "Truck added, plan refreshed");
      onSaved();
    } catch (e) { setErr(e instanceof ApiFailure ? e.message : "Couldn't save"); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!visit) return;
    setBusy(true);
    try { await api("DELETE", `/fleets/${fleetId}/depot-visits/${visit.id}`); toast("Removed from the plan"); onSaved(); } catch (e) { setErr(e instanceof ApiFailure ? e.message : "Couldn't remove"); } finally { setBusy(false); }
  };

  return (
    <Drawer title={visit ? "Edit truck" : "Add a truck"} sub={depot.name} onClose={onClose}
      foot={<div className="row gap-8" style={{ width: "100%" }}>
        {visit && <button className="btn ghost" disabled={busy} onClick={remove}><Icon name="trash" size="sm" />Remove</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.vehicle_id} onClick={save}>{busy ? <Spinner label="Saving" /> : null}{visit ? "Save" : "Add to plan"}</button>
      </div>}>
      <div className="stack gap-16">
        <Field label="Truck">{(id) => <select id={id} className="select" value={f.vehicle_id} onChange={(e) => setF({ ...f, vehicle_id: e.target.value })}>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} · {v.name}</option>)}</select>}</Field>
        <Field label="Charger" hint="Trucks can share a charger one after another.">{(id) => <select id={id} className="select" value={f.charger_id} onChange={(e) => setF({ ...f, charger_id: e.target.value })}><option value="">Not decided yet</option>{depot.chargers.map((c) => <option key={c.id} value={c.id}>{c.name} · {N0.format(c.max_kw)} kW</option>)}</select>}</Field>
        <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Arrives">{(id) => <input id={id} className="input" type="datetime-local" value={f.arrive} onChange={(e) => setF({ ...f, arrive: e.target.value })} />}</Field>
          <Field label="Leaves">{(id) => <input id={id} className="input" type="datetime-local" value={f.depart} onChange={(e) => setF({ ...f, depart: e.target.value })} />}</Field>
        </div>
        <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label={`Charge on arrival: ${f.soc_start}%`}>{(id) => <input id={id} className="range" type="range" min={0} max={100} step={1} value={f.soc_start} onChange={(e) => setF({ ...f, soc_start: Number(e.target.value) })} />}</Field>
          <Field label={`Needed when it leaves: ${f.soc_target}%`}>{(id) => <input id={id} className="range" type="range" min={0} max={100} step={1} value={f.soc_target} onChange={(e) => setF({ ...f, soc_target: Number(e.target.value) })} />}</Field>
        </div>
        <div className="hint">{kwh != null ? `About ${N0.format(kwh)} kWh into the battery.` : "This truck has no battery size yet: add it in Fleet so it can be planned."} Your systems can send these visits through the API too (POST /api/fleets/…/depot-visits).</div>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Drawer>
  );
}

// ---- depot settings (owners) -------------------------------------------------------------------

function DepotSettings({ energy, depotId, onClose, onSaved }: { energy: EnergyView; depotId: string | null; onClose(): void; onSaved(e: EnergyView, id: string): void }) {
  const { api, fleetId, toast, vehicles } = useApp();
  const [cfg, setCfg] = useState<EnergyConfig>(() => (energy.config.depots.length ? structuredClone(energy.config) : { ...energy.config, depots: [newDepot("Main depot")] }));
  const [id, setId] = useState(depotId ?? cfg.depots[0].id);
  const [secret, setSecret] = useState("");
  const [flexSecret, setFlexSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = cfg.depots.find((x) => x.id === id) ?? cfg.depots[0];
  const set = (patch: Partial<Depot>) => setCfg({ ...cfg, depots: cfg.depots.map((x) => (x.id === d.id ? { ...x, ...patch } : x)) });
  const setRate = (i: number, patch: Partial<DepotRate>) => set({ tariff: { ...d.tariff, rates: d.tariff.rates.map((r, j) => (j === i ? { ...r, ...patch } : r)) } });
  const hasSecret = energy.has_secret[d.id];

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const clean = cleanEnergy(cfg);
      const secrets: Record<string, string> = {};
      if (secret) secrets[d.id] = secret;
      if (flexSecret) secrets.flex = flexSecret;
      const e = await api<EnergyView>("PUT", `/fleets/${fleetId}/energy`, { config: clean, secrets: Object.keys(secrets).length ? secrets : undefined });
      toast("Depot settings saved");
      onSaved(e, d.id);
    } catch (x) { setErr(x instanceof ApiFailure ? x.message : "Couldn't save"); } finally { setBusy(false); }
  };

  return (
    <Drawer title="Depot settings" sub="Chargers, grid connection, tariff and how the chargers are controlled" onClose={onClose}
      foot={<div className="row gap-8" style={{ width: "100%" }}><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? <Spinner label="Saving" /> : null}Save</button></div>}>
      <div className="stack gap-20">
        {cfg.depots.length > 1 && <Field label="Depot">{(fid) => <select id={fid} className="select" value={d.id} onChange={(e) => setId(e.target.value)}>{cfg.depots.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>}
        <div className="stack gap-12">
          <h3>Site</h3>
          <div className="two" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <Field label="Name">{(fid) => <input id={fid} className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
            <Field label="Postcode" hint="For local grid carbon">{(fid) => <input id={fid} className="input" value={d.postcode} onChange={(e) => set({ postcode: e.target.value })} />}</Field>
          </div>
          <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Grid connection, kW" hint="Maximum import (your connection agreement)">{(fid) => <input id={fid} className="input" inputMode="numeric" value={d.import_limit_kw} onChange={(e) => set({ import_limit_kw: Number(e.target.value) || 0 })} />}</Field>
            <Field label="Other site load, kW" hint="Kept free for lighting, warehouse, reefers">{(fid) => <input id={fid} className="input" inputMode="numeric" value={d.site_load_kw} onChange={(e) => set({ site_load_kw: Number(e.target.value) || 0 })} />}</Field>
          </div>
          <div className="field"><span className="label">Plan for</span><Seg<DepotGoal> label="Plan for" full value={d.goal} onChange={(g) => set({ goal: g })} options={GOALS.map((g) => ({ value: g.value, label: g.label }))} /><span className="hint">{GOALS.find((g) => g.value === d.goal)?.hint}</span></div>
        </div>

        <div className="stack gap-12">
          <h3>Electricity tariff</h3>
          <Seg<"flat" | "tou" | "agile"> label="Tariff type" full value={d.tariff.kind} onChange={(k) => set({ tariff: { ...d.tariff, kind: k, rates: k === "tou" && !d.tariff.rates.length ? [{ price: 0.15, start: "00:30", end: "07:30" }] : d.tariff.rates } })}
            options={[{ value: "flat", label: "One rate" }, { value: "tou", label: "Time of use" }, { value: "agile", label: "Half-hourly (Agile)" }]} />
          <Field label={d.tariff.kind === "agile" ? "Fallback rate, £ per kWh ex VAT" : d.tariff.kind === "tou" ? "Standard rate, £ per kWh ex VAT" : "Rate, £ per kWh ex VAT"}>{(fid) => <input id={fid} className="input" inputMode="decimal" value={d.tariff.standard} onChange={(e) => set({ tariff: { ...d.tariff, standard: Number(e.target.value) } })} />}</Field>
          {d.tariff.kind === "tou" && (
            <div className="stack gap-8">
              {d.tariff.rates.map((r, i) => (
                <div key={i} className="rate-row">
                  <input className="input" aria-label="Rate £ per kWh" inputMode="decimal" value={r.price} onChange={(e) => setRate(i, { price: Number(e.target.value) })} />
                  <span className="small muted">from</span>
                  <input className="input" aria-label="From" type="time" value={r.start} onChange={(e) => setRate(i, { start: e.target.value })} />
                  <span className="small muted">to</span>
                  <input className="input" aria-label="To" type="time" value={r.end} onChange={(e) => setRate(i, { end: e.target.value })} />
                  <label className="small row gap-4"><input type="checkbox" checked={!!r.days} onChange={(e) => setRate(i, { days: e.target.checked ? ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"] : undefined })} />Weekdays</label>
                  <button className="btn sm ghost icon-only" aria-label="Remove rate" onClick={() => set({ tariff: { ...d.tariff, rates: d.tariff.rates.filter((_, j) => j !== i) } })}><Icon name="x" size="sm" /></button>
                </div>
              ))}
              {d.tariff.rates.length < 8 && <button className="btn sm" onClick={() => set({ tariff: { ...d.tariff, rates: [...d.tariff.rates, { price: 0.3, start: "16:00", end: "19:00" }] } })}><Icon name="plus" size="sm" />Add a timed rate</button>}
            </div>
          )}
          {d.tariff.kind === "agile" && (
            <div className="two" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
              <Field label="Octopus product code">{(fid) => <input id={fid} className="input" value={d.tariff.agile_product ?? "AGILE-24-10-01"} onChange={(e) => set({ tariff: { ...d.tariff, agile_product: e.target.value } })} />}</Field>
              <Field label="Region (A–P)">{(fid) => <input id={fid} className="input" maxLength={1} value={d.tariff.agile_region ?? "B"} onChange={(e) => set({ tariff: { ...d.tariff, agile_region: e.target.value.toUpperCase() } })} />}</Field>
            </div>
          )}
        </div>

        <div className="stack gap-12">
          <h3>Chargers</h3>
          {d.chargers.map((c, i) => (
            <div key={c.id} className="charger-row">
              <input className="input" aria-label="Charger name" value={c.name} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <input className="input" aria-label="OCPP station id" placeholder="Station id" value={c.station_id} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, station_id: e.target.value } : x)) })} />
              <input className="input" aria-label="Maximum kW" inputMode="numeric" value={c.max_kw} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, max_kw: Number(e.target.value) || 0 } : x)) })} />
              <span className="small muted">kW</span>
              <label className="small row gap-4" title="Can give power back (V2G, OCPP 2.1 / ISO 15118-20)"><input type="checkbox" checked={!!c.bidirectional} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, bidirectional: e.target.checked || undefined } : x)) })} />V2G</label>
              <button className="btn sm ghost icon-only" aria-label={`Remove ${c.name}`} onClick={() => set({ chargers: d.chargers.filter((_, j) => j !== i) })}><Icon name="x" size="sm" /></button>
            </div>
          ))}
          <button className="btn sm" onClick={() => set({ chargers: [...d.chargers, { id: uuid(), name: `Bay ${d.chargers.length + 1}`, station_id: `CP${String(d.chargers.length + 1).padStart(2, "0")}`, evse_id: 1, max_kw: 150 }] })}><Icon name="plus" size="sm" />Add a charger</button>
        </div>

        <div className="stack gap-12">
          <h3>Control</h3>
          <Seg<"simulated" | "citrineos" | "webhook"> label="How the chargers are controlled" full value={d.control.kind}
            onChange={(k) => set({ control: k === "citrineos" ? { kind: "citrineos", base_url: "", tenant_id: "1" } : k === "webhook" ? { kind: "webhook", url: "" } : { kind: "simulated" } })}
            options={[{ value: "simulated", label: "Not yet" }, { value: "citrineos", label: "CitrineOS" }, { value: "webhook", label: "Operator's system" }]} />
          {d.control.kind === "simulated" && <p className="small muted" style={{ margin: 0 }}>Plans are worked out but nothing is sent. Good for trying it out before the chargers are connected.</p>}
          {d.control.kind === "citrineos" && (
            <>
              <p className="small muted" style={{ margin: 0 }}>CitrineOS is a free, open-source charger management system (OCPP 2.0.1). Run it yourself or with your installer, connect the chargers to it, and we send it each charger's schedule.</p>
              <div className="two" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                <Field label="CitrineOS address">{(fid) => <input id={fid} className="input" placeholder="https://csms.example.com" value={d.control.kind === "citrineos" ? d.control.base_url : ""} onChange={(e) => d.control.kind === "citrineos" && set({ control: { ...d.control, base_url: e.target.value } })} />}</Field>
                <Field label="Tenant id">{(fid) => <input id={fid} className="input" value={d.control.kind === "citrineos" ? d.control.tenant_id : ""} onChange={(e) => d.control.kind === "citrineos" && set({ control: { ...d.control, tenant_id: e.target.value } })} />}</Field>
              </div>
              <Field label="API token (optional)" hint={hasSecret ? `Saved (ending ${d.control.token_hint ?? "…"}). Type a new one to replace it.` : "Sent as a Bearer token. Stored encrypted; never shown again."}>{(fid) => <input id={fid} className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>
            </>
          )}
          {d.control.kind === "webhook" && (
            <>
              <p className="small muted" style={{ margin: 0 }}>For a depot run by a charge point operator: we post each charger's OCPP 2.0.1 SetChargingProfile request to their system, signed so they can check it came from us.</p>
              <Field label="Their address">{(fid) => <input id={fid} className="input" placeholder="https://depot-operator.example/charging-profiles" value={d.control.kind === "webhook" ? d.control.url : ""} onChange={(e) => d.control.kind === "webhook" && set({ control: { ...d.control, url: e.target.value } })} />}</Field>
              <Field label="Signing secret" hint={hasSecret ? `Saved (ending ${d.control.secret_hint ?? "…"}). Type a new one to replace it.` : "Agree a secret with the operator. Stored encrypted."}>{(fid) => <input id={fid} className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>
            </>
          )}
          {d.control.kind !== "simulated" && <Switch checked={d.auto_dispatch} onChange={(v) => set({ auto_dispatch: v })}>Send updated schedules automatically every 15 minutes</Switch>}
        </div>
        <div className="stack gap-12">
          <h3>Vehicle-to-grid pilot</h3>
          <Switch checked={d.v2g.enabled} onChange={(v) => set({ v2g: { ...d.v2g, enabled: v } })}>Run a V2G pilot at this depot</Switch>
          {d.v2g.enabled && (
            <>
              <div className="field">
                <span className="label">Pilot trucks</span>
                {vehicles.map((v) => (
                  <label key={v.id} className="small row gap-6"><input type="checkbox" checked={d.v2g.vehicle_ids.includes(v.id)} onChange={(e) => set({ v2g: { ...d.v2g, vehicle_ids: e.target.checked ? [...d.v2g.vehicle_ids, v.id] : d.v2g.vehicle_ids.filter((x) => x !== v.id) } })} />{v.plate} · {v.name}</label>
                ))}
                <span className="hint">Mark the chargers that can give power back with V2G above.</span>
              </div>
              <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label={`Never below: ${d.v2g.min_soc}% charge`}>{(fid) => <input id={fid} className="range" type="range" min={10} max={90} step={5} value={d.v2g.min_soc} onChange={(e) => set({ v2g: { ...d.v2g, min_soc: Number(e.target.value) } })} />}</Field>
                <Field label="Most power to give back, kW">{(fid) => <input id={fid} className="input" inputMode="numeric" value={d.v2g.max_discharge_kw} onChange={(e) => set({ v2g: { ...d.v2g, max_discharge_kw: Number(e.target.value) || 0 } })} />}</Field>
              </div>
              <div className="field"><span className="label">Where the power goes</span>
                <Seg<"behind_meter" | "export"> label="V2G mode" full value={d.v2g.mode} onChange={(m) => set({ v2g: { ...d.v2g, mode: m } })} options={[{ value: "behind_meter", label: "Site only (no export)" }, { value: "export", label: "Export (G99 approved)" }]} />
                <span className="hint">{d.v2g.mode === "behind_meter" ? "Only covers the site's own load, so no export approval is needed." : "Needs your network operator's G99 approval for export."}</span>
              </div>
              <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {d.v2g.mode === "export" ? <Field label="Approved export, kW">{(fid) => <input id={fid} className="input" inputMode="numeric" value={d.v2g.export_limit_kw} onChange={(e) => set({ v2g: { ...d.v2g, export_limit_kw: Number(e.target.value) || 0 } })} />}</Field> : <span />}
                <Field label="Battery wear, £ per kWh cycled" hint="Only gives power back when the price gap beats this">{(fid) => <input id={fid} className="input" inputMode="decimal" value={d.v2g.wear_per_kwh} onChange={(e) => set({ v2g: { ...d.v2g, wear_per_kwh: Number(e.target.value) } })} />}</Field>
              </div>
              <label className="small row gap-6"><input type="checkbox" checked={d.v2g.warranty_confirmed} onChange={(e) => set({ v2g: { ...d.v2g, warranty_confirmed: e.target.checked } })} />The truck maker has confirmed in writing that bidirectional charging is covered by the battery warranty</label>
            </>
          )}
        </div>

        <div className="stack gap-12">
          <h3>Grid flexibility</h3>
          <Switch checked={d.flex.enabled} onChange={(v) => set({ flex: { ...d.flex, enabled: v } })}>Take part in grid flexibility at this depot</Switch>
          {d.flex.enabled && (
            <>
              <div className="field">
                <span className="label">Schemes</span>
                {(["DFS", "DNO", "BM"] as FlexProgramme[]).map((p) => (
                  <label key={p} className="small row gap-6"><input type="checkbox" checked={d.flex.programmes.includes(p)} onChange={(e) => set({ flex: { ...d.flex, programmes: e.target.checked ? [...d.flex.programmes, p] : d.flex.programmes.filter((x) => x !== p) } })} />{PROGRAMME_LABEL[p]}</label>
                ))}
              </div>
              <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <Field label="Lowest payment to accept, £/MWh">{(fid) => <input id={fid} className="input" inputMode="decimal" value={d.flex.min_price_mwh} onChange={(e) => set({ flex: { ...d.flex, min_price_mwh: Number(e.target.value) || 0 } })} />}</Field>
                <div className="field"><span className="label">Decisions</span><Switch checked={d.flex.auto_accept} onChange={(v) => set({ flex: { ...d.flex, auto_accept: v } })}>Accept automatically when every truck can still be ready</Switch></div>
              </div>
            </>
          )}
          <div className="field">
            <span className="label">Events come from (all depots)</span>
            <Seg<"simulated" | "aggregator"> label="Flexibility provider" full value={cfg.flex_provider.kind} onChange={(k) => setCfg({ ...cfg, flex_provider: { ...cfg.flex_provider, kind: k, name: k === "aggregator" ? (cfg.flex_provider.kind === "aggregator" ? cfg.flex_provider.name : "") : "Simulated aggregator" } })}
              options={[{ value: "simulated", label: "Simulated (try it out)" }, { value: "aggregator", label: "Your aggregator" }]} />
          </div>
          {cfg.flex_provider.kind === "aggregator" && (
            <>
              <p className="small muted" style={{ margin: 0 }}>Your flexibility aggregator holds the scheme registrations and sends events here. Give them the address below and agree a signing secret. We send our commitments and delivery reports to their address.</p>
              <div className="field"><span className="label">Your event address (for the aggregator)</span><code className="copyable">{typeof location !== "undefined" ? location.origin : ""}/api/flex/{fleetId}/events</code></div>
              <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
                <Field label="Aggregator">{(fid) => <input id={fid} className="input" placeholder="e.g. Axle Energy" value={cfg.flex_provider.name} onChange={(e) => setCfg({ ...cfg, flex_provider: { ...cfg.flex_provider, name: e.target.value } })} />}</Field>
                <Field label="Their report address">{(fid) => <input id={fid} className="input" placeholder="https://aggregator.example/reports" value={cfg.flex_provider.report_url ?? ""} onChange={(e) => setCfg({ ...cfg, flex_provider: { ...cfg.flex_provider, report_url: e.target.value } })} />}</Field>
              </div>
              <Field label="Signing secret" hint={energy.has_secret.flex ? `Saved (ending ${cfg.flex_provider.secret_hint ?? "…"}). Type a new one to replace it.` : "Both sides sign with it (HMAC-SHA256). Stored encrypted."}>{(fid) => <input id={fid} className="input" type="password" autoComplete="off" value={flexSecret} onChange={(e) => setFlexSecret(e.target.value)} />}</Field>
            </>
          )}
        </div>
        {err && <div className="error-text" role="alert">{err}</div>}
        <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={() => { const nd = newDepot(`Depot ${cfg.depots.length + 1}`); setCfg({ ...cfg, depots: [...cfg.depots, nd] }); setId(nd.id); }}><Icon name="plus" size="sm" />Add another depot</button>
      </div>
    </Drawer>
  );
}


// ---- grid flexibility -------------------------------------------------------------------------

const STATUS_LABEL: Record<FlexEvent["status"], { label: string; tone: "" | "ok" | "warn" | "bad" }> = {
  offered: { label: "Waiting for you", tone: "warn" },
  accepted: { label: "Accepted", tone: "ok" },
  declined: { label: "Declined", tone: "" },
  delivered: { label: "Delivered", tone: "ok" },
  settled: { label: "Paid", tone: "ok" },
  cancelled: { label: "Missed", tone: "" },
};

function FlexPanel({ depot, events, provider, now, canDecide, isOwner, onSettings, onChanged }: {
  depot: Depot; events: FlexEvent[]; provider: EnergyConfig["flex_provider"]; now: Date; canDecide: boolean; isOwner: boolean; onSettings(): void; onChanged(): Promise<void>;
}) {
  const { api, fleetId, toast } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [kind, setKind] = useState<"dno" | "dfs-down" | "dfs-up">("dno");
  const upcoming = events.filter((e) => Date.parse(e.end_at) > now.getTime() && (e.status === "offered" || e.status === "accepted"));
  const past = events.filter((e) => !upcoming.includes(e)).sort((a, b) => b.start_at.localeCompare(a.start_at)).slice(0, 8);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const earned = events.filter((e) => (e.status === "delivered" || e.status === "settled") && Date.parse(e.end_at) >= monthStart).reduce((a, e) => a + (e.fleet_credit_gbp ?? 0), 0);
  const act = async (e: FlexEvent, accept: boolean) => {
    setBusy(e.id);
    try {
      const r = await api<FlexEvent>("POST", `/fleets/${fleetId}/flex/${e.id}/${accept ? "accept" : "decline"}`);
      toast(r.status === "accepted" ? `Accepted: ${r.direction === "down" ? "charging eased off by" : "extra"} ${N0.format(r.committed_kw ?? 0)} kW, every truck still ready` : r.reason ?? "Declined", r.status === "accepted" ? undefined : "bad");
      await onChanged();
    } catch (x) { toast(x instanceof ApiFailure ? x.message : "Couldn't save", "bad"); } finally { setBusy(null); }
  };
  const simulate = async () => {
    setBusy("sim");
    try {
      const r = await api<FlexEvent>("POST", `/fleets/${fleetId}/flex/simulate`, { depot_id: depot.id, kind });
      toast(r.status === "accepted" ? "Event accepted and the plan updated" : r.status === "offered" ? "New event: accept or decline it below" : r.reason ?? "Event declined", r.status === "declined" ? "bad" : undefined);
      await onChanged();
    } catch (x) { toast(x instanceof ApiFailure ? x.message : "Couldn't create an event", "bad"); } finally { setBusy(null); }
  };
  return (
    <section className="panel section flex-panel">
      <div className="panel-head">
        <h2>Grid flexibility</h2>
        <span className="right row gap-8">
          {depot.flex.enabled && <span className="tag">{provider.name}</span>}
          {earned > 0 && <span className="tag ok">{fmtMoney(earned)} earned this month</span>}
        </span>
      </div>
      <div className="panel-body stack gap-12">
        {!depot.flex.enabled ? (
          <>
            <p className="small" style={{ margin: 0 }}>Get paid for easing off charging when the grid is stretched, or soaking up spare power when there's too much, through NESO's Demand Flexibility Service and local network (DNO) schemes. We only commit what this depot can do <b>without any truck leaving short</b>, and your share of the payment is credited on your monthly statement.</p>
            {isOwner ? <div><button className="btn sm" onClick={onSettings}><Icon name="zap" size="sm" />Switch on in depot settings</button></div> : <p className="xs muted" style={{ margin: 0 }}>A fleet owner can switch this on in depot settings.</p>}
          </>
        ) : (
          <>
            {upcoming.length === 0 && <p className="small muted" style={{ margin: 0 }}>No events coming up. {depot.flex.auto_accept ? "Events this depot can deliver are accepted automatically." : "You'll be asked to accept or decline each event."}</p>}
            {upcoming.length > 0 && <ul className="flex-list">{upcoming.map((e) => <FlexRow key={e.id} e={e} now={now} busy={busy === e.id} canDecide={canDecide} onAct={act} />)}</ul>}
            {provider.kind === "simulated" && canDecide && (
              <div className="flex-sim">
                <select className="select" aria-label="Kind of event" value={kind} onChange={(x) => setKind(x.target.value as typeof kind)}>
                  <option value="dno">Local network: turn down as the off-peak rush starts (00:30)</option>
                  <option value="dfs-down">NESO DFS: turn down at the evening peak (17:30)</option>
                  <option value="dfs-up">NESO DFS: turn up when wind is plentiful (21:00)</option>
                </select>
                <button className="btn sm" disabled={busy === "sim"} onClick={simulate}>{busy === "sim" ? <Spinner label="Creating" /> : <Icon name="play" size="sm" />}Try an event</button>
              </div>
            )}
            {past.length > 0 && (
              <details className="flex-past">
                <summary className="small">Earlier events ({past.length})</summary>
                <ul className="flex-list">{past.map((e) => <FlexRow key={e.id} e={e} now={now} busy={false} canDecide={false} onAct={act} />)}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function FlexRow({ e, now, busy, canDecide, onAct }: { e: FlexEvent; now: Date; busy: boolean; canDecide: boolean; onAct(e: FlexEvent, accept: boolean): void }) {
  const st = STATUS_LABEL[e.status];
  const a = new Date(e.start_at), b = new Date(e.end_at);
  const hours = (b.getTime() - a.getTime()) / 3_600_000;
  const estPay = e.committed_kw ? (e.committed_kw * hours / 1000) * e.price_per_mwh : null;
  return (
    <li className={`flex-row ${e.direction}`}>
      <span className="fr-icon" aria-hidden="true"><Icon name={e.direction === "down" ? "trendDown" : "trendUp"} /></span>
      <div className="fr-main">
        <div><b>{e.direction === "down" ? "Turn down" : "Turn up"}</b> · {fmtDay(a, now, TZ)} {fmtTime(a, TZ)}–{fmtTime(b, TZ)} <span className="muted small">· {PROGRAMME_LABEL[e.programme as FlexProgramme]}</span></div>
        <div className="xs muted">
          £{N0.format(e.price_per_mwh)}/MWh
          {e.committed_kw ? ` · ${e.direction === "down" ? `ease off by ${N0.format(e.committed_kw)} kW (from ${N0.format(e.baseline_kw ?? 0)} kW)` : `${N0.format(e.committed_kw)} kW extra`}, every truck still ready` : ""}
          {e.status === "offered" ? " · decide before it starts" : ""}
          {e.reason ? ` · ${e.reason}` : ""}
        </div>
      </div>
      <div className="fr-money">
        {e.fleet_credit_gbp != null ? <><b>{fmtMoney(e.fleet_credit_gbp)}</b><span className="xs muted">{e.estimated ? "your share, estimated" : "your share, paid"}</span></>
          : estPay != null ? <><b>~{fmtMoney(estPay)}</b><span className="xs muted">expected payment</span></> : null}
      </div>
      <div className="fr-status">
        <span className={`tag ${st.tone}`}>{st.label}</span>
        {e.status === "offered" && canDecide && (
          <span className="row gap-6">
            <button className="btn sm primary" disabled={busy} onClick={() => onAct(e, true)}>Accept</button>
            <button className="btn sm ghost" disabled={busy} onClick={() => onAct(e, false)}>Decline</button>
          </span>
        )}
      </div>
    </li>
  );
}

// ---- vehicle-to-grid pilot -----------------------------------------------------------------------

function V2gPanel({ depot, plan, vehicles, isOwner, onSettings }: { depot: Depot; plan: PlanResponse; vehicles: { id: string; plate: string; name: string }[]; isOwner: boolean; onSettings(): void }) {
  const { toast } = useApp();
  const cfg = depot.v2g;
  const r = plan.v2g;
  const pilotVisits = plan.visits.filter((v) => cfg.vehicle_ids.includes(v.visit.vehicle_id));
  const bidi = depot.chargers.filter((c) => c.bidirectional);
  const onBidi = pilotVisits.filter((v) => bidi.some((c) => c.id === v.visit.charger_id));
  const checks = [
    { ok: bidi.length > 0, label: "Bidirectional charger", detail: bidi.length ? bidi.map((c) => c.name).join(", ") : "Mark a charger that can give power back (OCPP 2.1, ISO 15118-20)" },
    { ok: cfg.vehicle_ids.length > 0, label: "Pilot truck", detail: cfg.vehicle_ids.length ? cfg.vehicle_ids.map((id) => vehicles.find((v) => v.id === id)?.plate ?? "?").join(", ") : "Choose the truck taking part" },
    { ok: onBidi.length > 0, label: "On a V2G charger tonight", detail: onBidi.length ? onBidi.map((v) => `${v.plate} on ${depot.chargers.find((c) => c.id === v.visit.charger_id)?.name}`).join(", ") : "Put a pilot truck's visit on a bidirectional charger" },
    { ok: cfg.warranty_confirmed, label: "Maker's warranty confirmed", detail: cfg.warranty_confirmed ? "Confirmed in writing" : "Ask the truck maker to confirm bidirectional use is covered" },
    { ok: cfg.mode === "behind_meter" || cfg.export_limit_kw > 0, label: cfg.mode === "behind_meter" ? "Site only: no export approval needed" : "G99 export approval", detail: cfg.mode === "behind_meter" ? "Power given back only covers the site's own load" : `${N0.format(cfg.export_limit_kw)} kW approved` },
  ];
  const download = async () => {
    const pilots = plan.visits.filter((v) => cfg.vehicle_ids.includes(v.visit.vehicle_id));
    const rows = [["Half-hour start", "Price £/kWh", "Grid g CO2/kWh", ...pilots.map((v) => `${v.plate} kW (+charge / -give back)`), "Site charging total kW"]];
    plan.slots.forEach((s, j) => rows.push([new Date(s.start).toISOString(), s.price.toFixed(4), s.carbon != null ? String(s.carbon) : "", ...pilots.map((v) => (v.plan.kw[j] ?? 0).toFixed(1)), plan.total_kw[j].toFixed(1)]));
    rows.push([], ["Given back kWh", r ? r.dischargedKwh.toFixed(1) : "0"], ["Recharged kWh", r ? r.rechargedKwh.toFixed(1) : "0"], ["Arbitrage £", r ? r.arbitrage.toFixed(2) : "0"], ["Battery wear £", r ? r.wear.toFixed(2) : "0"], ["Net £", r ? r.net.toFixed(2) : "0"], ["Lowest charge %", r?.minSocReached != null ? r.minSocReached.toFixed(0) : ""], ["Minimum allowed %", String(cfg.min_soc)], ["Mode", cfg.mode]);
    try { const { saveFile } = await import("../app/download"); const res = await saveFile(`v2g-pilot-${depot.name.replace(/[^\w-]+/g, "-")}.csv`, rows.map((x) => x.join(",")).join("\r\n") + "\r\n", "text/csv"); if (res === "saved") toast("Pilot data downloaded"); } catch { toast("Download failed", "bad"); }
  };
  if (!cfg.enabled) {
    return (
      <section className="panel section">
        <div className="panel-head"><h2>Vehicle-to-grid pilot</h2><span className="right tag">Pilot</span></div>
        <div className="panel-body stack gap-12">
          <p className="small" style={{ margin: 0 }}>Parked trucks can give power back at peak times and recharge overnight, cutting the site's peak bill and, with approval, exporting to the grid. It always keeps a minimum charge and every truck still leaves with what it needs. Start with one truck on one bidirectional charger: the UK government's V2X innovation programme has funded pilots like this.</p>
          {isOwner ? <div><button className="btn sm" onClick={onSettings}><Icon name="zap" size="sm" />Set up a pilot</button></div> : null}
        </div>
      </section>
    );
  }
  return (
    <section className="panel section">
      <div className="panel-head"><h2>Vehicle-to-grid pilot</h2><span className="right row gap-8"><span className="tag">{cfg.mode === "behind_meter" ? "Site only" : "Export"}</span>{isOwner && <button className="btn sm ghost" onClick={onSettings}>Pilot settings</button>}</span></div>
      <div className="panel-body stack gap-16">
        <ul className="v2g-checks">
          {checks.map((c) => <li key={c.label} className={c.ok ? "ok" : ""}><Icon name={c.ok ? "circleCheck" : "circleHelp"} size="sm" /><span><b>{c.label}</b><span className="xs muted">{c.detail}</span></span></li>)}
        </ul>
        {r && r.dischargedKwh > 0.5 ? (
          <div className="v2g-results">
            <div><span className="xs muted">Given back</span><b>{N0.format(r.dischargedKwh)} kWh</b></div>
            <div><span className="xs muted">Value after recharging</span><b>{fmtMoney(r.arbitrage)}</b></div>
            <div><span className="xs muted">Battery wear</span><b>{fmtMoney(r.wear)}</b></div>
            <div><span className="xs muted">Net benefit</span><b className="ok-text">{fmtMoney(r.net)}</b><span className="xs muted">≈ {fmtMoney(Math.round(r.net * 250))} a year (250 nights)</span></div>
            <div><span className="xs muted">Lowest charge</span><b>{r.minSocReached != null ? `${N0.format(r.minSocReached)}%` : "—"}</b><span className="xs muted">never below {cfg.min_soc}%</span></div>
          </div>
        ) : <p className="small muted" style={{ margin: 0 }}>{checks.every((c) => c.ok) ? "No give-back planned in this window: the price gap doesn't beat battery wear, or the truck's charge is too low to spare." : "Complete the checklist to start planning give-back."}</p>}
        <div className="row gap-8 wrap"><button className="btn sm" onClick={download}><Icon name="download" size="sm" />Pilot data for funders (CSV)</button><span className="xs muted">Half-hourly schedule, prices, carbon and results.</span></div>
      </div>
    </section>
  );
}
