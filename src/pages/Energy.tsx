// Depot smart charging, told simply. One headline answers "will every truck be ready, and what will
// it cost?"; one timeline puts the price, grid carbon, charging and each truck on the same clock; and
// everything else (grid payments, vehicle-to-grid, connecting the chargers) is one tap away.
// Colours follow the charging key: green ready to charge, blue charging, red fault.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { DepotDispatch, EnergyState } from "../../shared/model";
import { cleanEnergy, newDepot, type Depot, type DepotGoal, type DepotVisit, type EnergyConfig } from "../../shared/energy/depot";
import { carbonBand } from "../../shared/energy/carbon";
import { PROGRAMME_LABEL, type FlexEvent, type FlexProgramme } from "../../shared/energy/flex";
import type { DepotPlanView, PlanVisitView } from "../../server/depot";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtDay, fmtMoney, fmtTime } from "../app/format";
import { DataSources } from "../components/DataSources";
import { localToUtc, localDateKey, uuid } from "../../shared/util";
import { Drawer, Field, Icon, Plate, Seg, Spinner, Switch } from "../ui/ui";
import type { IconName } from "../ui/icon-data";
import { MoreList, MoreRow } from "../components/More";
import { SupplierPicker } from "../components/SupplierPicker";

type EnergyView = { config: EnergyConfig; state: EnergyState; has_secret: Record<string, boolean> };
type PlanResponse = DepotPlanView & { dispatch: DepotDispatch | null };

const N0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const TZ = "Europe/London";
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: TZ });
const GOALS: { value: DepotGoal; label: string; hint: string }[] = [
  { value: "cost", label: "Lowest cost", hint: "Cheapest half-hours, whatever the carbon." },
  { value: "balanced", label: "Balanced", hint: "Cheap first, and cleaner when prices are close (carbon valued at £100 a tonne)." },
  { value: "carbon", label: "Lowest carbon", hint: "Cleanest half-hours, accepting a little extra cost." },
];
const CONTROL_LABEL = { simulated: "Not connected yet", citrineos: "CitrineOS", webhook: "Depot operator's system" } as const;

/** 23.4p: how British energy prices are quoted. */
const pence = (gbp: number) => `${(gbp * 100).toFixed(1)}p`;
/** "18:30" today, "Wed 05:15" on another day. */
const when = (t: number | string, now: Date) => {
  const d = new Date(t);
  return fmtDay(d, now, TZ) === "Today" ? fmtTime(d, TZ) : `${WEEKDAY.format(d)} ${fmtTime(d, TZ)}`;
};

export function EnergyPage() {
  const { api, fleetId, me, vehicles, now, toast } = useApp();
  const role = me?.memberships.find((m) => m.fleet_id === fleetId)?.role;
  const canPlan = role === "owner" || role === "planner";
  const isOwner = role === "owner";
  const [energy, setEnergy] = useState<EnergyView | null>(null);
  const [depotId, setDepotId] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [visits, setVisits] = useState<DepotVisit[]>([]);
  const [flex, setFlex] = useState<FlexEvent[]>([]);
  const [editVisit, setEditVisit] = useState<DepotVisit | "new" | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<SettingsFocus | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [deciding, setDeciding] = useState<string | null>(null);
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
  const events = depot ? flex.filter((x) => x.depot_id === depot.id) : [];
  const offered = events.filter((e) => e.status === "offered" && Date.parse(e.end_at) > now.getTime());

  const send = async () => {
    if (!depot || !fleetId) return;
    setSending(true);
    try {
      const d = await api<DepotDispatch>("POST", `/fleets/${fleetId}/depots/${encodeURIComponent(depot.id)}/dispatch`);
      toast(d.ok ? `Plan sent to ${d.results.length} charger${d.results.length === 1 ? "" : "s"}` : "Some chargers didn't accept the plan", d.ok ? undefined : "bad");
      await load();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't send the plan", "bad");
    } finally { setSending(false); }
  };
  const setGoal = async (goal: DepotGoal) => {
    if (!energy || !depot || goal === depot.goal || !fleetId) return;
    setGoalBusy(true);
    try {
      const config = { ...energy.config, depots: energy.config.depots.map((d) => (d.id === depot.id ? { ...d, goal } : d)) };
      setEnergy(await api<EnergyView>("PUT", `/fleets/${fleetId}/energy`, { config }));
      await load();
    } catch (x) { toast(x instanceof ApiFailure ? x.message : "Couldn't change the plan", "bad"); } finally { setGoalBusy(false); }
  };
  const decide = async (e: FlexEvent, accept: boolean) => {
    setDeciding(e.id);
    try {
      const r = await api<FlexEvent>("POST", `/fleets/${fleetId}/flex/${e.id}/${accept ? "accept" : "decline"}`);
      toast(r.status === "accepted" ? `Accepted: ${r.direction === "down" ? "easing off by" : "an extra"} ${N0.format(r.committed_kw ?? 0)} kW, every truck still ready` : r.reason ?? "Declined", r.status === "accepted" ? undefined : "bad");
      await load();
    } catch (x) { toast(x instanceof ApiFailure ? x.message : "Couldn't save", "bad"); } finally { setDeciding(null); }
  };

  if (!energy) {
    return <div className="page"><div className="page-head"><h1>Depot smart charging</h1></div>{error ? <div className="panel panel-body error-text">{error}</div> : <div className="panel panel-body"><Spinner label="Loading" /></div>}</div>;
  }

  return (
    <div className="page energy">
      <div className="page-head">
        <div>
          <h1>Depot smart charging</h1>
          <div className="sub">{depot ? <>Every truck at {depot.name} charged at the cheapest, cleanest times, and ready before it leaves.</> : "Every truck charged at the cheapest, cleanest times, and ready before it leaves."}</div>
        </div>
        {depot && (
          <div className="actions">
            {energy.config.depots.length > 1 && (
              <select className="select" aria-label="Depot" value={depotId ?? ""} onChange={(e) => setDepotId(e.target.value)}>
                {energy.config.depots.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
            {isOwner && <button className="btn ghost" onClick={() => setSettingsOpen("top")}><Icon name="sliders" size="sm" />Settings</button>}
            {canPlan && <button className="btn primary" onClick={() => setEditVisit("new")}><Icon name="plus" size="sm" />Add truck</button>}
          </div>
        )}
      </div>

      {!depot ? <SetupInvite isOwner={isOwner} onStart={() => setSettingsOpen("top")} />
        : !plan ? <div className="panel panel-body"><Spinner label="Planning" /></div>
        : (
          <>
            <PlanStory plan={plan} depot={depot} now={now} canPlan={canPlan} offered={offered} deciding={deciding} onDecide={decide} onEdit={(v) => setEditVisit(v)} onAdd={() => setEditVisit("new")}
              isOwner={isOwner} goalBusy={goalBusy} onGoal={setGoal} />
            {plan.visits.length > 0 && <PlanTimeline plan={plan} depot={depot} now={now} canEdit={canPlan} onEdit={(v) => setEditVisit(v)} onSettings={isOwner ? (f) => setSettingsOpen(f) : undefined} />}
            <MoreFromDepot depot={depot} plan={plan} events={events} provider={energy.config.flex_provider} vehicles={vehicles} now={now} canPlan={canPlan} isOwner={isOwner}
              sending={sending} onSend={send} onSettings={(f) => setSettingsOpen(f ?? "top")} onChanged={load} deciding={deciding} onDecide={decide} />
            <DataSources />
          </>
        )}

      {editVisit && depot && (
        <VisitDrawer depot={depot} visit={editVisit === "new" ? null : editVisit} vehicles={vehicles} now={now} onClose={() => setEditVisit(null)}
          onSaved={async () => { setEditVisit(null); await load(); }} existing={visits} />
      )}
      {settingsOpen && (
        <DepotSettings energy={energy} depotId={depotId} focus={settingsOpen} onClose={() => setSettingsOpen(null)} onSaved={async (e, id) => { setEnergy(e); setDepotId(id); setSettingsOpen(null); await load(); }} />
      )}
    </div>
  );
}

// ---- first visit: three things to tell us ----------------------------------------------------

function SetupInvite({ isOwner, onStart }: { isOwner: boolean; onStart(): void }) {
  return (
    <section className="panel en-setup">
      <h2>Set up your depot</h2>
      <p>Tell us three things and every night's charging is planned for you: cheapest and cleanest first, and every truck ready on time.</p>
      <ol className="en-steps">
        <li><b>Your site</b><span>Its postcode and grid connection, so the plan never goes over it.</span></li>
        <li><b>Your electricity</b><span>Octopus, a wholesale-linked contract or your own rates.</span></li>
        <li><b>Your chargers</b><span>How many and how powerful. You can connect them later.</span></li>
      </ol>
      {isOwner ? <div><button className="btn primary" onClick={onStart}>Set up a depot</button></div> : <p className="small muted">A fleet owner can set up the depot.</p>}
    </section>
  );
}

// ---- the headline -------------------------------------------------------------------------------

function PlanStory({ plan, depot, now, canPlan, offered, deciding, onDecide, onEdit, onAdd, isOwner, goalBusy, onGoal }: {
  plan: PlanResponse; depot: Depot; now: Date; canPlan: boolean; offered: FlexEvent[]; deciding: string | null;
  onDecide(e: FlexEvent, accept: boolean): void; onEdit(v: DepotVisit): void; onAdd(): void;
  isOwner: boolean; goalBusy: boolean; onGoal(g: DepotGoal): void;
}) {
  const visits = plan.visits;
  if (!visits.length) {
    return (
      <section className="panel en-story empty">
        <span className="en-story-icon"><Icon name="plug" /></span>
        <div className="en-story-text">
          <h2>No trucks in the plan yet</h2>
          <p>Add the trucks staying at {depot.name}: when they arrive, when they leave and how much charge they need. The rest is worked out for you.</p>
          {canPlan && <div className="en-story-cta"><button className="btn primary" onClick={onAdd}><Icon name="plus" size="sm" />Add a truck</button></div>}
        </div>
      </section>
    );
  }
  const short = visits.filter((v) => v.outcome === "short");
  const all = short.length === 0;
  const saved = plan.baseline.cost - plan.cost;
  const kgCut = plan.baseline.kg > 0 ? (plan.baseline.kg - plan.kg) / plan.baseline.kg : 0;
  const n = visits.length;
  return (
    <section className={`panel en-story ${all ? "ok" : "warn"}`} aria-live="polite">
      <span className="en-story-icon"><Icon name={all ? "circleCheck" : "alert"} /></span>
      <div className="en-story-text">
        <h2>{all ? (n === 1 ? "The truck will be ready on time" : `All ${n} trucks will be ready on time`) : `${n - short.length} of ${n} trucks will be ready on time`}</h2>
        <p>
          Charging will cost <b>{fmtMoney(plan.cost)}</b>
          {saved >= 0.5 ? <>, <b className="en-good">{fmtMoney(saved)} less</b> than plugging in on arrival</> : ", about the same as plugging in on arrival"}
          {kgCut >= 0.01 ? <>, with <b className="en-good">{N0.format(kgCut * 100)}% less CO₂</b></> : null}.
          <span className="en-fine"> Ex VAT.</span>
        </p>
        <div className="en-goal">
          <span className="en-goal-label">Plan for</span>
          {isOwner
            ? <Seg<DepotGoal> label="Plan for" value={depot.goal} onChange={onGoal} options={GOALS.map((g) => ({ value: g.value, label: g.label }))} />
            : <b>{GOALS.find((g) => g.value === depot.goal)?.label}</b>}
          {goalBusy ? <Spinner label="Re-planning" /> : <span className="en-fine">{GOALS.find((g) => g.value === depot.goal)?.hint}</span>}
        </div>
      </div>
      {(short.length > 0 || offered.length > 0) && (
        <ul className="en-asks">
          {short.map((v) => (
            <li key={v.visit.id}>
              <span className="en-ask-icon warn"><Icon name="batteryLow" size="sm" /></span>
              <span className="grow"><b>{v.plate}</b> would leave at {N0.format(v.soc_ready)}%, not {v.visit.soc_target}%. Give it longer, or a faster charger.</span>
              {canPlan && <button className="btn sm" onClick={() => onEdit(v.visit)}>Change</button>}
            </li>
          ))}
          {offered.map((e) => (
            <li key={e.id}>
              <span className="en-ask-icon"><Icon name={e.direction === "down" ? "trendDown" : "trendUp"} size="sm" /></span>
              <span className="grow">
                The grid will pay <b>£{N0.format(e.price_per_mwh)}/MWh</b> to {e.direction === "down" ? "ease off" : "charge more"} {when(e.start_at, now)}–{fmtTime(new Date(e.end_at), TZ)}.
                {e.committed_kw ? <> {e.direction === "down" ? "Easing off" : "An extra"} {N0.format(e.committed_kw)} kW keeps every truck ready.</> : null}
              </span>
              {canPlan && (
                <span className="row gap-6">
                  <button className="btn sm primary" disabled={deciding === e.id} onClick={() => onDecide(e, true)}>Accept</button>
                  <button className="btn sm ghost" disabled={deciding === e.id} onClick={() => onDecide(e, false)}>Decline</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type SettingsFocus = "top" | "site" | "electricity" | "chargers" | "connect" | "flex" | "v2g";

/** A setting shown as it is; for owners, tapping it opens that setting. */
function Chip({ icon, onClick, label, children }: { icon: IconName; onClick?: () => void; label: string; children: ReactNode }) {
  const body = <><Icon name={icon} size="sm" /><span className="en-chip-text">{children}</span>{onClick && <span className="en-chip-edit" aria-hidden="true"><Icon name="pencil" size="sm" /></span>}</>;
  return onClick
    ? <button type="button" className="en-chip editable" onClick={onClick} title={label}>{body}<span className="sr-only">: {label}</span></button>
    : <span className="en-chip">{body}</span>;
}

// ---- one timeline: price, carbon, charging and every truck on the same clock -------------------

interface Run { a: number; b: number; avg: number }
/** Consecutive half-hours charging (sign 1) or giving power back (sign -1), as one block each. */
function runsOf(kw: number[], sign: 1 | -1): Run[] {
  const out: Run[] = [];
  let start = -1, sum = 0;
  for (let j = 0; j <= kw.length; j++) {
    const on = j < kw.length && (sign > 0 ? kw[j] >= 0.05 : kw[j] <= -0.05);
    if (on) { if (start < 0) { start = j; sum = 0; } sum += Math.abs(kw[j]); }
    else if (start >= 0) { out.push({ a: start, b: j, avg: sum / (j - start) }); start = -1; }
  }
  return out;
}

function PlanTimeline({ plan, depot, now, canEdit, onEdit, onSettings }: { plan: PlanResponse; depot: Depot; now: Date; canEdit: boolean; onEdit(v: DepotVisit): void; onSettings?(f: SettingsFocus): void }) {
  const S = plan.slots.length;
  const t0 = plan.slots[0].start, t1 = plan.slots[S - 1].end;
  const at = (t: number) => ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * 100;
  const pc = (j: number) => `${(j / S) * 100}%`;
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const priceRef = useRef<HTMLDivElement>(null);

  // Price, as a step line.
  const prices = plan.slots.map((s) => s.price);
  const pLo = Math.min(...prices), pHi = Math.max(...prices);
  const iLo = prices.indexOf(pLo), iHi = prices.indexOf(pHi);
  const py = (p: number) => 14 + (1 - (p - pLo) / (pHi - pLo || 1)) * 72;
  let line = "";
  plan.slots.forEach((s, j) => { const x0 = (j / S) * 100, x1 = ((j + 1) / S) * 100, y = py(s.price).toFixed(2); line += j === 0 ? `M${x0} ${y}H${x1}` : `V${y}H${x1}`; });

  // Grid carbon, as a strip: darker is dirtier.
  const carbon = plan.slots.map((s) => s.carbon);
  const known = carbon.filter((c): c is number => c != null);
  const cLo = known.length ? Math.min(...known) : 0, cHi = known.length ? Math.max(...known) : 1;
  const iClean = known.length ? carbon.indexOf(cLo) : -1;

  // Charging: everyone's power in one bar per half-hour; giving back below the line.
  const pos = plan.slots.map((_, j) => plan.visits.reduce((a, v) => a + Math.max(0, v.plan.kw[j] ?? 0), 0));
  const neg = plan.slots.map((_, j) => plan.visits.reduce((a, v) => a + Math.min(0, v.plan.kw[j] ?? 0), 0));
  const top = Math.max(plan.headroom_kw, ...pos, 1) * 1.12;
  const below = Math.max(0, ...neg.map((x) => -x));
  const range = top + below;
  const axis = (below / range) * 100;
  const kwPct = (kw: number) => (kw / range) * 100;
  const giving = below > 0.05;
  const events = (plan.events ?? []).map((e) => ({ e, a: at(Date.parse(e.start_at)), b: at(Date.parse(e.end_at)) })).filter((x) => x.b > x.a);
  const nowPct = at(now.getTime());

  const ticks = plan.slots.map((s, j) => ({ j, d: new Date(s.start) }))
    .filter(({ d }) => d.getUTCMinutes() === 0)
    .map(({ j, d }) => ({ j, d, hh: Number(fmtTime(d, TZ).slice(0, 2)) }))
    .filter((t) => t.hh % 3 === 0 && t.j > 0);

  const pick = (clientX: number) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    const f = (clientX - r.left) / r.width;
    return f < 0 || f >= 1 ? null : Math.floor(f * S);
  };
  const onPointer = (e: PointerEvent<HTMLDivElement>) => setHover(pick(e.clientX));
  const firstCharge = Math.max(0, pos.findIndex((kw) => kw >= 0.05));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(k)) return;
    e.preventDefault();
    setHover((h) => k === "Home" ? 0 : k === "End" ? S - 1 : Math.max(0, Math.min(S - 1, (h ?? firstCharge) + (k === "ArrowLeft" ? -1 : 1))));
  };

  // The readout for the chosen half-hour, also announced to screen readers.
  const s = hover != null ? plan.slots[hover] : null;
  const evHere = s ? (plan.events ?? []).find((e) => Date.parse(e.start_at) < s.end && Date.parse(e.end_at) > s.start) : undefined;
  const here = hover != null ? plan.visits.map((v) => ({ v, kw: v.plan.kw[hover] ?? 0 })).filter((x) => Math.abs(x.kw) >= 0.05) : [];
  const readout = s && hover != null
    ? `${when(s.start, now)} to ${fmtTime(new Date(s.end), TZ)}: ${pence(s.price)} per kWh${s.carbon != null ? `, ${s.carbon} grams of CO2` : ""}, ${here.length ? `${N0.format(pos[hover])} kilowatts charging` : "nothing charging"}.`
    : "";
  // The readout sits beside the chosen half-hour (right of it in the first half, left in the second).
  const tipRight = hover != null && hover < S / 2;
  let tipX = 0;
  if (hover != null && priceRef.current) {
    const w = priceRef.current.getBoundingClientRect().width;
    tipX = (w * (tipRight ? hover + 1 : hover)) / S + (tipRight ? 10 : -10);
  }
  const hoverBar = hover != null ? <span className="en-hover" style={{ left: pc(hover), width: `${100 / S}%` }} /> : null;
  const nowLine = nowPct > 1 && nowPct < 99 ? <span className="en-now" style={{ left: `${nowPct}%` }} /> : null;

  const live = !plan.price.modelled && plan.price.source !== "fixed";
  const carbonWords = plan.carbon_source === "neso" ? "NESO forecast" : plan.carbon_source === "mixed" ? "NESO forecast, modelled beyond 48 hours" : "modelled";

  return (
    <section className="panel en-plan" aria-labelledby="en-plan-h">
      <div className="en-plan-head">
        <div className="grow">
          <h2 id="en-plan-h">Charging plan</h2>
          <div className="en-chips">
            <Chip icon="zap" onClick={onSettings && (() => onSettings("electricity"))} label="Change the electricity supplier">
              {live && <span className="en-live" aria-hidden="true" />}{plan.price.label}{live ? (plan.price.estimated_from ? `, live (estimated after ${when(plan.price.estimated_from, now)})` : ", live") : ""}
            </Chip>
            <Chip icon="gauge" onClick={onSettings && (() => onSettings("site"))} label="Change the grid connection">{N0.format(plan.headroom_kw)} kW for charging</Chip>
            <Chip icon="plug" onClick={onSettings && (() => onSettings("chargers"))} label="Change the chargers">{depot.chargers.length} charger{depot.chargers.length === 1 ? "" : "s"}</Chip>
          </div>
          <p className="en-src">Grid CO₂: {carbonWords}</p>
        </div>
        <ul className="en-legend" aria-label="Key">
          <li><i className="stay" />Plugged in, ready</li>
          <li><i className="on" />Charging</li>
          {giving && <li><i className="give" />Giving back</li>}
          {events.length > 0 && <li><i className="ev" />Grid event</li>}
        </ul>
      </div>

      <div className="en-timeline" onPointerMove={onPointer} onPointerDown={onPointer} onPointerLeave={() => setHover(null)}>
        <div className="en-row en-price">
          <div className="en-label"><b>Price</b><span className="en-sub">p per kWh</span></div>
          <div className="en-plot" ref={priceRef}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path d={`${line}V100H0Z`} className="en-price-area" />
              <path d={line} className="en-price-line" />
            </svg>
            <span className="en-note hi" style={{ left: `clamp(18px, ${((iHi + 0.5) / S) * 100}%, calc(100% - 18px))`, top: `${py(pHi)}%` }}>{pence(pHi)}</span>
            <span className="en-note lo" style={{ left: `clamp(18px, ${((iLo + 0.5) / S) * 100}%, calc(100% - 18px))`, top: `${py(pLo)}%` }}>{pence(pLo)}</span>
            {nowLine}{hoverBar}
            {s && hover != null && (
              <div className={`en-tip ${tipRight ? "right" : "left"}`} style={{ left: tipX }} aria-hidden="true">
                <b>{when(s.start, now)}–{fmtTime(new Date(s.end), TZ)}</b>
                <span>{pence(s.price)} per kWh{s.carbon != null ? ` · ${s.carbon} g CO₂, ${carbonBand(s.carbon).label.toLowerCase()}` : ""}</span>
                <span>{here.length ? `${N0.format(pos[hover])} kW charging${neg[hover] < -0.05 ? `, ${N0.format(-neg[hover])} kW given back` : ""}` : "Nothing charging"}</span>
                {here.slice(0, 6).map(({ v, kw }) => <span key={v.visit.id} className="en-tip-row"><i className={kw < 0 ? "give" : "on"} />{v.plate} {kw < 0 ? `gives back ${N0.format(-kw)} kW` : `${N0.format(kw)} kW`}</span>)}
                {evHere && <span>Grid event: {evHere.direction === "down" ? "easing off" : "extra charging"}{evHere.status === "offered" ? " (waiting for you)" : ""}</span>}
              </div>
            )}
          </div>
          <div className="en-status" />
        </div>

        <div className="en-row en-carbon">
          <div className="en-label"><b>Grid CO₂</b><span className="en-sub">stronger = more CO₂</span></div>
          <div className="en-plot">
            <div className="en-strip" aria-hidden="true">
              {carbon.map((c, j) => <span key={j} style={{ opacity: c == null ? 0 : 0.08 + (0.8 * (c - cLo)) / (cHi - cLo || 1) }} />)}
            </div>
            {iClean >= 0 && <span className="en-note clean" style={{ left: `clamp(26px, ${((iClean + 0.5) / S) * 100}%, calc(100% - 26px))` }}>cleanest</span>}
            {nowLine}{hoverBar}
          </div>
          <div className="en-status" />
        </div>

        <div className="en-row en-load">
          <div className="en-label"><b>Charging</b><span className="en-sub">all trucks, kW</span></div>
          <div className="en-plot">
            {events.map(({ e, a, b }) => (
              <span key={e.id} className={`en-event ${e.direction} ${e.status}`} style={{ left: `${a}%`, width: `${b - a}%` }}>
                <b>{e.direction === "down" ? "Ease off" : "Extra"}{e.status === "offered" ? "?" : ""}</b>
              </span>
            ))}
            <span className="en-limit" style={{ bottom: `${axis + kwPct(plan.headroom_kw)}%` }}><span>{N0.format(plan.headroom_kw)} kW limit</span></span>
            {pos.map((kw, j) => kw >= 0.05 ? <span key={`p${j}`} className={`en-bar${j === 0 ? " live" : ""}`} style={{ left: pc(j), width: `calc(${100 / S}% - 1px)`, bottom: `${axis}%`, height: `${kwPct(kw)}%` }} /> : null)}
            {neg.map((kw, j) => kw <= -0.05 ? <span key={`n${j}`} className="en-bar give" style={{ left: pc(j), width: `calc(${100 / S}% - 1px)`, bottom: `${axis - kwPct(-kw)}%`, height: `${kwPct(-kw)}%` }} /> : null)}
            <span className="en-axis0" style={{ bottom: `${axis}%` }} />
            {nowLine}{hoverBar}
          </div>
          <div className="en-status"><span className="en-sub">peak {N0.format(plan.peak_kw)} kW</span></div>
        </div>

        <div className="en-trucks">
          {plan.visits.map((v) => <TruckRow key={v.visit.id} v={v} depot={depot} S={S} at={at} t0={t0} now={now} hoverBar={hoverBar} canEdit={canEdit} onEdit={onEdit} />)}
        </div>

        <div className="en-row en-axis">
          <div className="en-label" />
          <div className="en-plot" ref={plotRef} tabIndex={0} role="slider" aria-label="Half-hour" aria-valuemin={0} aria-valuemax={S - 1} aria-valuenow={hover ?? firstCharge} aria-valuetext={readout || "Use the arrow keys to read each half-hour"}
            onKeyDown={onKey} onFocus={() => setHover((h) => h ?? firstCharge)} onBlur={() => setHover(null)}>
            {ticks.map(({ j, d, hh }) => <span key={j} className={`en-tick${hh === 0 ? " day" : ""}${hh % 6 ? " minor" : ""}`} style={{ left: pc(j) }}>{hh === 0 ? WEEKDAY.format(d) : fmtTime(d, TZ)}</span>)}
          </div>
          <div className="en-status" />
        </div>
        <div className="sr-only" aria-live="polite">{readout}</div>
      </div>
    </section>
  );
}

function TruckRow({ v, depot, S, at, t0, now, hoverBar, canEdit, onEdit }: {
  v: PlanVisitView; depot: Depot; S: number; at(t: number): number; t0: number; now: Date; hoverBar: ReactNode; canEdit: boolean; onEdit(v: DepotVisit): void;
}) {
  const a = Date.parse(v.visit.arrive_at), b = Date.parse(v.visit.depart_at);
  const ch = depot.chargers.find((c) => c.id === v.visit.charger_id);
  const left = at(a), right = at(b);
  const here = a <= now.getTime();
  const on = runsOf(v.plan.kw, 1), back = runsOf(v.plan.kw, -1);
  const pct = (j: number) => `${(j / S) * 100}%`;
  const ready = v.plan.readyAt ? fmtTime(new Date(v.plan.readyAt), TZ) : null;
  // The charge now, from the truck itself when it reported recently (telematics).
  const truckAt = v.soc_from ? fmtTime(new Date(v.soc_from.at), TZ) : null;
  const soc = truckAt
    ? <span className="en-fromtruck" title={`From the truck at ${truckAt}`}><Icon name="wifi" size="sm" />{v.visit.soc_start}%</span>
    : <>{v.visit.soc_start}%</>;
  const status = v.outcome === "ready"
    ? <><span className="en-ready"><Icon name="circleCheck" size="sm" />Ready{ready ? ` by ${ready}` : ""}</span><span className="en-sub">{soc} → {N0.format(v.soc_ready)}%</span></>
    : v.outcome === "short"
      ? <><span className="en-short"><Icon name="alert" size="sm" />{N0.format(v.plan.shortfallKwh)} kWh short</span><span className="en-sub">{soc} → {N0.format(v.soc_ready)}% of {v.visit.soc_target}%</span></>
      : <span className="en-sub">{v.battery_kwh ? <>Already at {soc}</> : "Add its battery size in Fleet"}</span>;
  const words = `${v.plate}${v.name ? `, ${v.name}` : ""}${ch ? ` on ${ch.name}` : ""}: ${here ? "here now" : `arrives ${when(a, now)}`}, leaves ${when(b, now)}. ${v.outcome === "ready" ? `Ready${ready ? ` by ${ready}` : ""}, ${v.visit.soc_start}% to ${N0.format(v.soc_ready)}%.` : v.outcome === "short" ? `${N0.format(v.plan.shortfallKwh)} kilowatt hours short.` : ""}${truckAt ? ` Charge reported by the truck at ${truckAt}.` : ""}`;
  const wide = right - left > 24;
  const body = (
    <>
      <div className="en-label"><Plate plate={v.plate} size="sm" /><span className="en-sub ellipsis">{v.name ?? ""}{ch ? ` · ${ch.name}` : ""}</span></div>
      <div className="en-plot">
        <span className="en-stay" style={{ left: `${left}%`, width: `${Math.max(0.6, right - left)}%` }} />
        {on.map((r) => <span key={`c${r.a}`} className={`en-on${r.a === 0 && here ? " live" : ""}`} style={{ left: pct(r.a), width: pct(r.b - r.a), opacity: 0.6 + 0.4 * Math.min(1, r.avg / Math.max(1, v.max_kw)) }} />)}
        {back.map((r) => <span key={`g${r.a}`} className="en-give" style={{ left: pct(r.a), width: pct(r.b - r.a) }} />)}
        {wide
          ? <><span className="en-time" style={{ left: `${left}%` }}>{a < t0 ? "Here now" : fmtTime(new Date(a), TZ)}</span><span className="en-time end" style={{ left: `${right}%` }}>{fmtTime(new Date(b), TZ)}</span></>
          : <span className="en-time" style={{ left: `${Math.min(left, 80)}%` }}>{fmtTime(new Date(a), TZ)}–{fmtTime(new Date(b), TZ)}</span>}
        {hoverBar}
      </div>
      <div className="en-status">{status}</div>
      {canEdit && <span className="en-row-chev" aria-hidden="true"><Icon name="chevronRight" size="sm" /></span>}
    </>
  );
  return canEdit
    ? <button type="button" className="en-row en-truck" onClick={() => onEdit(v.visit)} aria-label={`${words} Edit`}>{body}</button>
    : <div className="en-row en-truck" role="group" aria-label={words}>{body}</div>;
}

// ---- everything else, one tap away -------------------------------------------------------------

function MoreFromDepot({ depot, plan, events, provider, vehicles, now, canPlan, isOwner, sending, onSend, onSettings, onChanged, deciding, onDecide }: {
  depot: Depot; plan: PlanResponse; events: FlexEvent[]; provider: EnergyConfig["flex_provider"]; vehicles: { id: string; plate: string; name: string }[]; now: Date;
  canPlan: boolean; isOwner: boolean; sending: boolean; onSend(): void; onSettings(f?: SettingsFocus): void; onChanged(): Promise<void>; deciding: string | null; onDecide(e: FlexEvent, accept: boolean): void;
}) {
  // Grid flexibility, in one line.
  const t = now.getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const earned = events.filter((e) => (e.status === "delivered" || e.status === "settled") && Date.parse(e.end_at) >= monthStart).reduce((a, e) => a + (e.fleet_credit_gbp ?? 0), 0);
  const waiting = events.filter((e) => e.status === "offered" && Date.parse(e.end_at) > t).length;
  const coming = events.filter((e) => e.status === "accepted" && Date.parse(e.end_at) > t).length;
  const flexParts = [waiting ? `${waiting} waiting for you` : "", coming ? `${coming} coming up` : "", earned > 0 ? `${fmtMoney(earned)} earned this month` : ""].filter(Boolean);
  const flexSummary = !depot.flex.enabled ? "Off. Get paid to ease off charging when the grid is busy." : flexParts.length ? flexParts.join(" · ") : "On. No events coming up.";

  // Vehicle-to-grid, in one line.
  const r = plan.v2g;
  const pilots = plan.visits.filter((v) => depot.v2g.vehicle_ids.includes(v.visit.vehicle_id));
  const v2gSummary = !depot.v2g.enabled ? "Off. Parked trucks could give power back at the evening peak."
    : r && r.dischargedKwh > 0.5 ? `${pilots.map((v) => v.plate).join(", ") || "The pilot truck"} gives back ${N0.format(r.dischargedKwh)} kWh at the peak: ${fmtMoney(r.net)} net`
    : "On. Nothing to give back in this plan.";

  // Chargers, in one line. A charger that refused the plan is a fault (red).
  const d = plan.dispatch;
  const failed = d ? d.results.filter((x) => !x.ok).length : 0;
  const chargerSummary = depot.control.kind === "simulated" ? "Not connected yet: the plan is worked out, not sent"
    : failed ? `${failed} charger${failed === 1 ? "" : "s"} didn't accept the plan`
    : d ? `${CONTROL_LABEL[depot.control.kind]}, plan sent ${when(d.at, now)}${depot.auto_dispatch ? ", updated every 15 minutes" : ""}`
    : `${CONTROL_LABEL[depot.control.kind]}, not sent yet`;

  return (
    <MoreList label="More from this depot">
      <MoreRow icon="plug" title="Chargers" summary={chargerSummary} tone={failed ? "bad" : d && depot.control.kind !== "simulated" ? "ok" : undefined}>
        <ChargersBody depot={depot} plan={plan} canSend={canPlan} sending={sending} onSend={onSend} isOwner={isOwner} onSettings={() => onSettings("connect")} now={now} />
      </MoreRow>
      <MoreRow icon="activity" title="Grid flexibility" summary={flexSummary} tone={waiting ? "warn" : earned > 0 ? "ok" : undefined}>
        <FlexBody depot={depot} events={events} provider={provider} now={now} canDecide={canPlan} isOwner={isOwner} onSettings={() => onSettings("flex")} onChanged={onChanged} deciding={deciding} onDecide={onDecide} />
      </MoreRow>
      <MoreRow icon="swap" title="Vehicle-to-grid pilot" summary={v2gSummary}>
        <V2gBody depot={depot} plan={plan} isOwner={isOwner} onSettings={() => onSettings("v2g")} />
      </MoreRow>
      {vehicles.length === 0 && <p className="xs muted" style={{ padding: "0 20px 14px", margin: 0 }}>Add your trucks in Fleet first.</p>}
    </MoreList>
  );
}

function ChargersBody({ depot, plan, canSend, sending, onSend, isOwner, onSettings, now }: { depot: Depot; plan: PlanResponse; canSend: boolean; sending: boolean; onSend(): void; isOwner: boolean; onSettings(): void; now: Date }) {
  const d = plan.dispatch;
  const name = (id: string) => depot.chargers.find((c) => c.id === id)?.name ?? id;
  return (
    <div className="stack gap-12">
      <p className="small" style={{ margin: 0 }}>
        {depot.control.kind === "simulated"
          ? <>The plan is worked out but not sent anywhere yet. {isOwner ? "Connect the chargers through CitrineOS (free and open source) or your depot operator's system." : "Ask a fleet owner to connect the chargers."}</>
          : <>Each charger is sent its power limit for every half-hour (an OCPP 2.0.1 charging profile). If the connection drops, chargers fall back to their own settings.</>}
      </p>
      {d && (
        <ul className="dispatch-list">
          {d.results.map((x) => <li key={x.charger_id} className={x.ok ? "" : "bad"}><Icon name={x.ok ? "circleCheck" : "circleX"} size="sm" /><b>{name(x.charger_id)}</b><span className="muted small">{x.message}</span></li>)}
        </ul>
      )}
      {(canSend || isOwner) && (
        <div className="row gap-8 wrap" style={{ alignItems: "center" }}>
          {isOwner && depot.control.kind === "simulated" && <button className="btn sm" onClick={onSettings}><Icon name="plug" size="sm" />Connect the chargers</button>}
          {canSend && <button className={`btn sm ${depot.control.kind === "simulated" ? "ghost" : "primary"}`} disabled={sending || !plan.visits.length} onClick={onSend}>{sending ? <Spinner label="Sending" /> : <Icon name="zap" size="sm" />}Send the plan to the chargers</button>}
          {canSend && <span className="xs muted">{d ? `Last sent ${when(d.at, now)} (${d.by === "auto" ? "automatically" : "by hand"})` : "Not sent yet"}</span>}
        </div>
      )}
    </div>
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

function FlexBody({ depot, events, provider, now, canDecide, isOwner, onSettings, onChanged, deciding, onDecide }: {
  depot: Depot; events: FlexEvent[]; provider: EnergyConfig["flex_provider"]; now: Date; canDecide: boolean; isOwner: boolean; onSettings(): void; onChanged(): Promise<void>;
  deciding: string | null; onDecide(e: FlexEvent, accept: boolean): void;
}) {
  const { api, fleetId, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<"dno" | "dfs-down" | "dfs-up">("dno");
  const upcoming = events.filter((e) => Date.parse(e.end_at) > now.getTime() && (e.status === "offered" || e.status === "accepted"));
  const past = events.filter((e) => !upcoming.includes(e)).sort((a, b) => b.start_at.localeCompare(a.start_at)).slice(0, 8);
  const simulate = async () => {
    setBusy(true);
    try {
      const r = await api<FlexEvent>("POST", `/fleets/${fleetId}/flex/simulate`, { depot_id: depot.id, kind });
      toast(r.status === "accepted" ? "Event accepted and the plan updated" : r.status === "offered" ? "New event: accept or decline it at the top of the page" : r.reason ?? "Event declined", r.status === "declined" ? "bad" : undefined);
      await onChanged();
    } catch (x) { toast(x instanceof ApiFailure ? x.message : "Couldn't create an event", "bad"); } finally { setBusy(false); }
  };
  if (!depot.flex.enabled) {
    return (
      <div className="stack gap-12">
        <p className="small" style={{ margin: 0 }}>The grid pays for flexibility: easing off charging when it's stretched, or soaking up spare power when there's too much, through NESO's Demand Flexibility Service and local network schemes. Only what this depot can do <b>without any truck leaving short</b> is ever committed, and your share is credited on your monthly statement.</p>
        {isOwner ? <div><button className="btn sm" onClick={onSettings}><Icon name="zap" size="sm" />Switch on in settings</button></div> : <p className="xs muted" style={{ margin: 0 }}>A fleet owner can switch this on in settings.</p>}
      </div>
    );
  }
  return (
    <div className="stack gap-12">
      <p className="xs muted" style={{ margin: 0 }}>Events come from {provider.name || "your aggregator"}. {depot.flex.auto_accept ? "Events this depot can deliver are accepted automatically." : "You decide on each one."}</p>
      {upcoming.length > 0 ? <ul className="flex-list">{upcoming.map((e) => <FlexRow key={e.id} e={e} now={now} busy={deciding === e.id} canDecide={canDecide} onAct={onDecide} />)}</ul> : <p className="small muted" style={{ margin: 0 }}>No events coming up.</p>}
      {provider.kind === "simulated" && canDecide && (
        <div className="flex-sim">
          <select className="select" aria-label="Kind of event" value={kind} onChange={(x) => setKind(x.target.value as typeof kind)}>
            <option value="dno">Local network: ease off as the off-peak rush starts (00:30)</option>
            <option value="dfs-down">NESO DFS: ease off at the evening peak (17:30)</option>
            <option value="dfs-up">NESO DFS: charge more when wind is plentiful (21:00)</option>
          </select>
          <button className="btn sm" disabled={busy} onClick={simulate}>{busy ? <Spinner label="Creating" /> : <Icon name="play" size="sm" />}Try an event</button>
        </div>
      )}
      {past.length > 0 && (
        <details className="flex-past">
          <summary className="small">Earlier events ({past.length})</summary>
          <ul className="flex-list">{past.map((e) => <FlexRow key={e.id} e={e} now={now} busy={false} canDecide={false} onAct={onDecide} />)}</ul>
        </details>
      )}
    </div>
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
        <div><b>{e.direction === "down" ? "Ease off" : "Charge more"}</b> · {when(e.start_at, now)}–{fmtTime(b, TZ)} <span className="muted small">· {PROGRAMME_LABEL[e.programme as FlexProgramme]}</span></div>
        <div className="xs muted">
          £{N0.format(e.price_per_mwh)}/MWh
          {e.committed_kw ? ` · ${e.direction === "down" ? `${N0.format(e.committed_kw)} kW less (from ${N0.format(e.baseline_kw ?? 0)} kW)` : `${N0.format(e.committed_kw)} kW extra`}, every truck still ready` : ""}
          {e.status === "offered" ? " · decide before it starts" : ""}
          {e.reason ? ` · ${e.reason}` : ""}
        </div>
      </div>
      <div className="fr-money">
        {e.fleet_credit_gbp != null ? <><b>{fmtMoney(e.fleet_credit_gbp)}</b><span className="xs muted">{e.estimated ? "your share, estimated" : "your share, paid"}</span></>
          : estPay != null ? <><b>~{fmtMoney(estPay)}</b><span className="xs muted">expected</span></> : null}
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

function V2gBody({ depot, plan, isOwner, onSettings }: { depot: Depot; plan: PlanResponse; isOwner: boolean; onSettings(): void }) {
  const { toast } = useApp();
  const cfg = depot.v2g;
  const r = plan.v2g;
  const pilotVisits = plan.visits.filter((v) => cfg.vehicle_ids.includes(v.visit.vehicle_id));
  const bidi = depot.chargers.filter((c) => c.bidirectional);
  const onBidi = pilotVisits.filter((v) => bidi.some((c) => c.id === v.visit.charger_id));
  const checks = [
    { ok: bidi.length > 0, label: "A charger that can give power back", detail: "Tick V2G on it in settings (OCPP 2.1, ISO 15118-20)" },
    { ok: cfg.vehicle_ids.length > 0, label: "A pilot truck", detail: "Choose the truck taking part" },
    { ok: onBidi.length > 0, label: "The pilot truck on that charger", detail: "Put its stay on the V2G charger" },
    { ok: cfg.warranty_confirmed, label: "The maker's warranty confirmed", detail: "Ask the truck maker to confirm in writing" },
    { ok: cfg.mode === "behind_meter" || cfg.export_limit_kw > 0, label: "Export approval (G99)", detail: "Or keep it to the site's own load" },
  ];
  const todo = checks.filter((c) => !c.ok);
  const download = async () => {
    const rows = [["Half-hour start", "Price £/kWh", "Grid g CO2/kWh", ...pilotVisits.map((v) => `${v.plate} kW (+charge / -give back)`), "Site charging total kW"]];
    plan.slots.forEach((s, j) => rows.push([new Date(s.start).toISOString(), s.price.toFixed(4), s.carbon != null ? String(s.carbon) : "", ...pilotVisits.map((v) => (v.plan.kw[j] ?? 0).toFixed(1)), plan.total_kw[j].toFixed(1)]));
    rows.push([], ["Given back kWh", r ? r.dischargedKwh.toFixed(1) : "0"], ["Recharged kWh", r ? r.rechargedKwh.toFixed(1) : "0"], ["Arbitrage £", r ? r.arbitrage.toFixed(2) : "0"], ["Battery wear £", r ? r.wear.toFixed(2) : "0"], ["Net £", r ? r.net.toFixed(2) : "0"], ["Lowest charge %", r?.minSocReached != null ? r.minSocReached.toFixed(0) : ""], ["Minimum allowed %", String(cfg.min_soc)], ["Mode", cfg.mode]);
    try { const { saveFile } = await import("../app/download"); const res = await saveFile(`v2g-pilot-${depot.name.replace(/[^\w-]+/g, "-")}.csv`, rows.map((x) => x.join(",")).join("\r\n") + "\r\n", "text/csv"); if (res === "saved") toast("Pilot data downloaded"); } catch { toast("Download failed", "bad"); }
  };
  if (!cfg.enabled) {
    return (
      <div className="stack gap-12">
        <p className="small" style={{ margin: 0 }}>Parked trucks can give power back at the evening peak and recharge overnight, cutting the site's peak bill. A minimum charge is always kept, and every truck still leaves with what it needs. Start with one truck on one bidirectional charger: the UK government's V2X innovation programme has funded pilots like this.</p>
        {isOwner && <div><button className="btn sm" onClick={onSettings}><Icon name="zap" size="sm" />Set up a pilot</button></div>}
      </div>
    );
  }
  return (
    <div className="stack gap-12">
      {r && r.dischargedKwh > 0.5 ? (
        <div className="figures">
          <div><b>{N0.format(r.dischargedKwh)} kWh</b><span>given back at the peak</span></div>
          <div><b className="en-good">{fmtMoney(r.net)}</b><span>net in this plan ({fmtMoney(r.arbitrage)} less {fmtMoney(r.wear)} battery wear), about {fmtMoney(Math.round(r.net * 250))} a year</span></div>
          <div><b>{r.minSocReached != null ? `${N0.format(r.minSocReached)}%` : "—"}</b><span>lowest charge; never below {cfg.min_soc}%</span></div>
        </div>
      ) : <p className="small muted" style={{ margin: 0 }}>{todo.length ? "Finish the checklist to start planning give-back." : "Nothing to give back in this plan: the price gap doesn't beat battery wear, or the truck's charge is too low to spare."}</p>}
      {todo.length > 0
        ? <ul className="en-todo">{todo.map((c) => <li key={c.label}><Icon name="circleHelp" size="sm" /><span><b>{c.label}</b><span className="xs muted">{c.detail}</span></span></li>)}</ul>
        : <p className="xs muted en-done"><Icon name="circleCheck" size="sm" />Charger, truck, warranty and {cfg.mode === "behind_meter" ? "site-only mode" : "export approval"} all in place.</p>}
      <div className="row gap-8 wrap">
        <button className="btn sm" onClick={download}><Icon name="download" size="sm" />Pilot data for funders (CSV)</button>
        {isOwner && <button className="btn sm ghost" onClick={onSettings}>Pilot settings</button>}
      </div>
    </div>
  );
}

// ---- add / edit a truck's stay -------------------------------------------------------------------

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
    <Drawer title={visit ? `Edit ${veh?.plate ?? "truck"}` : "Add a truck"} sub={depot.name} onClose={onClose}
      foot={<div className="row gap-8" style={{ width: "100%" }}>
        {visit && <button className="btn ghost" disabled={busy} onClick={remove}><Icon name="trash" size="sm" />Remove</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !f.vehicle_id} onClick={save}>{busy ? <Spinner label="Saving" /> : null}{visit ? "Save" : "Add to plan"}</button>
      </div>}>
      <div className="stack gap-16">
        <Field label="Truck">{(id) => <select id={id} className="select" value={f.vehicle_id} onChange={(e) => setF({ ...f, vehicle_id: e.target.value })}>{vehicles.map((v) => <option key={v.id} value={v.id}>{v.plate} · {v.name}</option>)}</select>}</Field>
        <DayTime label="Arrives" value={f.arrive} now={now} onChange={(v) => setF({ ...f, arrive: v })} />
        <DayTime label="Leaves" value={f.depart} now={now} onChange={(v) => setF({ ...f, depart: v })} />
        <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <Field label={`Charge on arrival: ${f.soc_start}%`}>{(id) => <input id={id} className="range" type="range" min={0} max={100} step={5} value={f.soc_start} onChange={(e) => setF({ ...f, soc_start: Number(e.target.value) })} />}</Field>
          <div className="field">
            <label className="label" htmlFor="soc-need">Needed when it leaves: {f.soc_target}%</label>
            <input id="soc-need" className="range" type="range" min={0} max={100} step={5} value={f.soc_target} onChange={(e) => setF({ ...f, soc_target: Number(e.target.value) })} />
            <div className="en-presets">{[80, 90, 100].map((n) => <button key={n} type="button" className={`en-preset${f.soc_target === n ? " on" : ""}`} aria-pressed={f.soc_target === n} onClick={() => setF({ ...f, soc_target: n })}>{n}%</button>)}</div>
          </div>
        </div>
        <Field label="Charger" hint="Trucks can share a charger, one after another.">{(id) => <select id={id} className="select" value={f.charger_id} onChange={(e) => setF({ ...f, charger_id: e.target.value })}><option value="">Not decided yet</option>{depot.chargers.map((c) => <option key={c.id} value={c.id}>{c.name} · {N0.format(c.max_kw)} kW</option>)}</select>}</Field>
        <div className="hint">{kwh != null ? `About ${N0.format(kwh)} kWh into the battery, at the cheapest, cleanest times before it leaves.` : "This truck has no battery size yet: add it in Fleet so it can be planned."}</div>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </Drawer>
  );
}

/** Today, tomorrow or another day, and a time: quicker than a date-and-time picker. */
function DayTime({ label, value, now, onChange }: { label: string; value: string; now: Date; onChange(v: string): void }) {
  const today = localDateKey(now, TZ);
  const tomorrow = localDateKey(new Date(now.getTime() + 24 * 3_600_000), TZ);
  const [date, time] = value.split("T");
  const which = date === today ? "today" : date === tomorrow ? "tomorrow" : "other";
  const [other, setOther] = useState(which === "other");
  const day = other ? "other" : which;
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="en-daytime">
        <Seg<"today" | "tomorrow" | "other"> label={`${label}: day`} value={day}
          onChange={(v) => { if (v === "other") { setOther(true); return; } setOther(false); onChange(`${v === "today" ? today : tomorrow}T${time}`); }}
          options={[{ value: "today", label: "Today" }, { value: "tomorrow", label: "Tomorrow" }, { value: "other", label: "Another day" }]} />
        {other && <input className="input" type="date" aria-label={`${label}: date`} value={date} onChange={(e) => e.target.value && onChange(`${e.target.value}T${time}`)} />}
        <input className="input en-time-input" type="time" step={900} aria-label={`${label}: time`} value={time} onChange={(e) => e.target.value && onChange(`${date}T${e.target.value}`)} />
      </div>
    </div>
  );
}

// ---- depot settings (owners): three essentials, the rest folded away -------------------------------

function Adv({ id, title, summary, open, children }: { id: string; title: string; summary: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="en-adv" id={id} open={open}>
      <summary><span className="grow"><b>{title}</b><span className="xs muted">{summary}</span></span><span className="more-chev" aria-hidden="true"><Icon name="chevronDown" size="sm" /></span></summary>
      <div className="stack gap-12">{children}</div>
    </details>
  );
}

function DepotSettings({ energy, depotId, focus, onClose, onSaved }: { energy: EnergyView; depotId: string | null; focus: SettingsFocus; onClose(): void; onSaved(e: EnergyView, id: string): void }) {
  const { api, fleetId, toast, vehicles } = useApp();
  const setup = energy.config.depots.length === 0;
  const [cfg, setCfg] = useState<EnergyConfig>(() => (energy.config.depots.length ? structuredClone(energy.config) : { ...energy.config, depots: [newDepot("Main depot")] }));
  const [id, setId] = useState(depotId ?? cfg.depots[0].id);
  const [secret, setSecret] = useState("");
  const [flexSecret, setFlexSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = cfg.depots.find((x) => x.id === id) ?? cfg.depots[0];
  const set = (patch: Partial<Depot>) => setCfg({ ...cfg, depots: cfg.depots.map((x) => (x.id === d.id ? { ...x, ...patch } : x)) });
  const hasSecret = energy.has_secret[d.id];
  const [region, setRegion] = useState<string | null>(null);
  useEffect(() => {
    if (!d.postcode || d.postcode.length < 2) { setRegion(null); return; }
    const t = setTimeout(() => { void api<{ region: string | null }>("GET", `/public/region?postcode=${encodeURIComponent(d.postcode)}`).then((r) => setRegion(r.region)).catch(() => setRegion(null)); }, 400);
    return () => clearTimeout(t);
  }, [api, d.postcode]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const clean = cleanEnergy(cfg);
      const secrets: Record<string, string> = {};
      if (secret) secrets[d.id] = secret;
      if (flexSecret) secrets.flex = flexSecret;
      const e = await api<EnergyView>("PUT", `/fleets/${fleetId}/energy`, { config: clean, secrets: Object.keys(secrets).length ? secrets : undefined });
      toast(setup ? "Depot set up: add your trucks to see the plan" : "Settings saved");
      onSaved(e, d.id);
    } catch (x) { setErr(x instanceof ApiFailure ? x.message : "Couldn't save"); } finally { setBusy(false); }
  };
  const step = (n: number, title: string) => <h3 className="en-set-h">{setup && <span className="en-num">{n}</span>}{title}</h3>;
  // Opened from a setting on the page: start at that section.
  useEffect(() => {
    if (focus === "top") return;
    const t = setTimeout(() => document.getElementById(`set-${focus}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 120);
    return () => clearTimeout(t);
  }, [focus]);
  const flexOn = d.flex.enabled ? `On: ${d.flex.programmes.join(", ") || "no schemes chosen"}` : "Off";

  return (
    <Drawer title={setup ? "Set up your depot" : "Depot settings"} sub={setup ? "Your site, your electricity and your chargers. Everything else can wait." : d.name} onClose={onClose}
      foot={<div className="row gap-8" style={{ width: "100%" }}><span className="grow" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? <Spinner label="Saving" /> : null}{setup ? "Save and plan" : "Save"}</button></div>}>
      <div className="stack gap-24">
        {cfg.depots.length > 1 && <Field label="Depot">{(fid) => <select id={fid} className="select" value={d.id} onChange={(e) => setId(e.target.value)}>{cfg.depots.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>}

        <section className="stack gap-12" id="set-site">
          {step(1, "Your site")}
          <div className="two" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <Field label="Name">{(fid) => <input id={fid} className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
            <Field label="Postcode" hint="For local prices and carbon">{(fid) => <input id={fid} className="input" value={d.postcode} onChange={(e) => set({ postcode: e.target.value })} />}</Field>
          </div>
          <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Grid connection, kW" hint="The most the site can import">{(fid) => <input id={fid} className="input" inputMode="numeric" value={d.import_limit_kw} onChange={(e) => set({ import_limit_kw: Number(e.target.value) || 0 })} />}</Field>
            <Field label="Kept for the site, kW" hint="Lighting, warehouse, reefers">{(fid) => <input id={fid} className="input" inputMode="numeric" value={d.site_load_kw} onChange={(e) => set({ site_load_kw: Number(e.target.value) || 0 })} />}</Field>
          </div>
        </section>

        <section className="stack gap-12" id="set-electricity">
          {step(2, "Your electricity")}
          <SupplierPicker value={d.tariff} onChange={(tariff) => set({ tariff })} regionFromPostcode={region} />
          <div className="field"><span className="label">Plan for</span><Seg<DepotGoal> label="Plan for" full value={d.goal} onChange={(g) => set({ goal: g })} options={GOALS.map((g) => ({ value: g.value, label: g.label }))} /><span className="hint">{GOALS.find((g) => g.value === d.goal)?.hint}</span></div>
        </section>

        <section className="stack gap-12" id="set-chargers">
          {step(3, "Your chargers")}
          {d.chargers.map((c, i) => (
            <div key={c.id} className="charger-row">
              <input className="input" aria-label="Charger name" value={c.name} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <input className="input" aria-label="Maximum kW" inputMode="numeric" value={c.max_kw} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, max_kw: Number(e.target.value) || 0 } : x)) })} />
              <span className="small muted">kW</span>
              <label className="small row gap-4" title="Can give power back (V2G, OCPP 2.1 / ISO 15118-20)"><input type="checkbox" checked={!!c.bidirectional} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, bidirectional: e.target.checked || undefined } : x)) })} />V2G</label>
              <button className="btn sm ghost icon-only" aria-label={`Remove ${c.name}`} onClick={() => set({ chargers: d.chargers.filter((_, j) => j !== i) })}><Icon name="x" size="sm" /></button>
            </div>
          ))}
          <div><button className="btn sm" onClick={() => set({ chargers: [...d.chargers, { id: uuid(), name: `Bay ${d.chargers.length + 1}`, station_id: `CP${String(d.chargers.length + 1).padStart(2, "0")}`, evse_id: 1, max_kw: 150 }] })}><Icon name="plus" size="sm" />Add a charger</button></div>
        </section>

        {!setup && (
          <div className="stack gap-8">
            <Adv id="set-connect" open={focus === "connect"} title="Connect the chargers" summary={CONTROL_LABEL[d.control.kind]}>
              <Seg<"simulated" | "citrineos" | "webhook"> label="How the chargers are controlled" full value={d.control.kind}
                onChange={(k) => set({ control: k === "citrineos" ? { kind: "citrineos", base_url: "", tenant_id: "1" } : k === "webhook" ? { kind: "webhook", url: "" } : { kind: "simulated" } })}
                options={[{ value: "simulated", label: "Not yet" }, { value: "citrineos", label: "CitrineOS" }, { value: "webhook", label: "Operator's system" }]} />
              {d.control.kind === "simulated" && <p className="small muted" style={{ margin: 0 }}>The plan is worked out but nothing is sent. Good for trying it out before the chargers are connected.</p>}
              {d.control.kind === "citrineos" && (
                <>
                  <p className="small muted" style={{ margin: 0 }}>CitrineOS is a free, open-source charger management system (OCPP 2.0.1). Connect the chargers to it, and each charger's plan is sent through it.</p>
                  <div className="two" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
                    <Field label="CitrineOS address">{(fid) => <input id={fid} className="input" placeholder="https://csms.example.com" value={d.control.kind === "citrineos" ? d.control.base_url : ""} onChange={(e) => d.control.kind === "citrineos" && set({ control: { ...d.control, base_url: e.target.value } })} />}</Field>
                    <Field label="Tenant id">{(fid) => <input id={fid} className="input" value={d.control.kind === "citrineos" ? d.control.tenant_id : ""} onChange={(e) => d.control.kind === "citrineos" && set({ control: { ...d.control, tenant_id: e.target.value } })} />}</Field>
                  </div>
                  <Field label="API token (optional)" hint={hasSecret ? `Saved (ending ${d.control.token_hint ?? "…"}). Type a new one to replace it.` : "Sent as a Bearer token. Stored encrypted; never shown again."}>{(fid) => <input id={fid} className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>
                </>
              )}
              {d.control.kind === "webhook" && (
                <>
                  <p className="small muted" style={{ margin: 0 }}>For a depot run by a charge point operator: each charger's OCPP 2.0.1 SetChargingProfile request is posted to their system, signed so they can check it came from you.</p>
                  <Field label="Their address">{(fid) => <input id={fid} className="input" placeholder="https://depot-operator.example/charging-profiles" value={d.control.kind === "webhook" ? d.control.url : ""} onChange={(e) => d.control.kind === "webhook" && set({ control: { ...d.control, url: e.target.value } })} />}</Field>
                  <Field label="Signing secret" hint={hasSecret ? `Saved (ending ${d.control.secret_hint ?? "…"}). Type a new one to replace it.` : "Agree a secret with the operator. Stored encrypted."}>{(fid) => <input id={fid} className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />}</Field>
                </>
              )}
              {d.control.kind !== "simulated" && (
                <>
                  <div className="field"><span className="label">OCPP station ids</span>
                    {d.chargers.map((c, i) => (
                      <div key={c.id} className="row gap-8" style={{ alignItems: "center" }}><span className="small" style={{ minWidth: 80 }}>{c.name}</span><input className="input" aria-label={`${c.name} OCPP station id`} placeholder="Station id" value={c.station_id} onChange={(e) => set({ chargers: d.chargers.map((x, j) => (j === i ? { ...x, station_id: e.target.value } : x)) })} /></div>
                    ))}
                  </div>
                  <Switch checked={d.auto_dispatch} onChange={(v) => set({ auto_dispatch: v })}>Send updated plans automatically every 15 minutes</Switch>
                </>
              )}
            </Adv>

            <Adv id="set-flex" open={focus === "flex"} title="Grid flexibility" summary={flexOn}>
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
                  <p className="small muted" style={{ margin: 0 }}>Your flexibility aggregator holds the scheme registrations and sends events here. Give them the address below and agree a signing secret. Commitments and delivery reports go to their address.</p>
                  <div className="field"><span className="label">Your event address (for the aggregator)</span><code className="copyable">{typeof location !== "undefined" ? location.origin : ""}/api/flex/{fleetId}/events</code></div>
                  <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
                    <Field label="Aggregator">{(fid) => <input id={fid} className="input" placeholder="e.g. Axle Energy" value={cfg.flex_provider.name} onChange={(e) => setCfg({ ...cfg, flex_provider: { ...cfg.flex_provider, name: e.target.value } })} />}</Field>
                    <Field label="Their report address">{(fid) => <input id={fid} className="input" placeholder="https://aggregator.example/reports" value={cfg.flex_provider.report_url ?? ""} onChange={(e) => setCfg({ ...cfg, flex_provider: { ...cfg.flex_provider, report_url: e.target.value } })} />}</Field>
                  </div>
                  <Field label="Signing secret" hint={energy.has_secret.flex ? `Saved (ending ${cfg.flex_provider.secret_hint ?? "…"}). Type a new one to replace it.` : "Both sides sign with it (HMAC-SHA256). Stored encrypted."}>{(fid) => <input id={fid} className="input" type="password" autoComplete="off" value={flexSecret} onChange={(e) => setFlexSecret(e.target.value)} />}</Field>
                </>
              )}
            </Adv>

            <Adv id="set-v2g" open={focus === "v2g"} title="Vehicle-to-grid pilot" summary={d.v2g.enabled ? `On: ${d.v2g.mode === "behind_meter" ? "site only" : "export"}` : "Off"}>
              <Switch checked={d.v2g.enabled} onChange={(v) => set({ v2g: { ...d.v2g, enabled: v } })}>Run a V2G pilot at this depot</Switch>
              {d.v2g.enabled && (
                <>
                  <div className="field">
                    <span className="label">Pilot trucks</span>
                    {vehicles.map((v) => (
                      <label key={v.id} className="small row gap-6"><input type="checkbox" checked={d.v2g.vehicle_ids.includes(v.id)} onChange={(e) => set({ v2g: { ...d.v2g, vehicle_ids: e.target.checked ? [...d.v2g.vehicle_ids, v.id] : d.v2g.vehicle_ids.filter((x) => x !== v.id) } })} />{v.plate} · {v.name}</label>
                    ))}
                    <span className="hint">Tick V2G on the chargers that can give power back.</span>
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
            </Adv>
          </div>
        )}
        {err && <div className="error-text" role="alert">{err}</div>}
        {!setup && <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={() => { const nd = newDepot(`Depot ${cfg.depots.length + 1}`); setCfg({ ...cfg, depots: [...cfg.depots, nd] }); setId(nd.id); }}><Icon name="plus" size="sm" />Add another depot</button>}
      </div>
    </Drawer>
  );
}
