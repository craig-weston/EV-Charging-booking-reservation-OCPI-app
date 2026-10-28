// Plan a trip: charging stops along a long-distance route, each with a bookable slot, booked in
// one go. A planning estimate (straight line × road factor, average speed and consumption), shown
// with its assumptions so the planner can adjust them.
import { useEffect, useMemo, useState } from "react";
import type { BookingRow } from "../../shared/model";
import { CITIES } from "../map/ukmap";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { DEFAULT_TZ, fmtDay, fmtDuration, fmtRange, fmtTime } from "../app/format";
import { DEFAULT_KWH_PER_KM, planTrip, type TripPlan } from "../app/trip";
import { href, navigate } from "../app/router";
import { Empty, Field, Icon, Plate, Spinner, StatusBadge } from "../ui/ui";
import { localDateKey, localToUtc, MINUTE, ceilToStep } from "../../shared/util";

const PLACES = [...CITIES].sort((a, b) => a.name.localeCompare(b.name));
const miles = (km: number) => Math.round(km * 0.621371);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function TripPage() {
  const { vehicles, drivers, network, now, api, fleetId, upsertBooking, bookings, toast, refreshNetwork } = useApp();
  const active = vehicles.filter((v) => v.active);
  const [vehicleId, setVehicleId] = useState<string>("");
  const [fromName, setFromName] = useState("London");
  const [toName, setToName] = useState("Glasgow");
  const tomorrow = new Date(now.getTime() + 24 * 60 * MINUTE);
  const [date, setDate] = useState(localDateKey(tomorrow, DEFAULT_TZ));
  const [time, setTime] = useState("05:00");
  const [startPct, setStartPct] = useState("90");
  const [kwhPerKm, setKwhPerKm] = useState("");
  const [speed, setSpeed] = useState("70");
  const [driverId, setDriverId] = useState("");
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState<(string | { error: string })[]>([]);

  useEffect(() => { void refreshNetwork().catch(() => undefined); }, [refreshNetwork]);
  useEffect(() => {
    if (!vehicleId && active.length) setVehicleId((active.find((v) => v.vehicle_type === "TRUCK_WITH_TRAILER" || v.vehicle_type === "SEMI_TRACTOR") ?? active[0]).id);
  }, [active, vehicleId]);
  const vehicle = active.find((v) => v.id === vehicleId) ?? null;
  const defaultKpk = vehicle ? DEFAULT_KWH_PER_KM[vehicle.vehicle_type] ?? 1.2 : 1.2;

  const depart = useMemo(() => {
    const [y, m, d] = date.split("-").map(Number);
    const [hh, mm] = time.split(":").map(Number);
    const t = y && m && d ? localToUtc(y, m, d, hh || 0, mm || 0, DEFAULT_TZ) : now;
    return t < now ? ceilToStep(new Date(now.getTime() + 15 * MINUTE), 15) : t;
  }, [date, time, now]);

  const minute = Math.floor(now.getTime() / 60_000);
  const inputs = JSON.stringify([vehicleId, fromName, toName, depart.toISOString(), startPct, kwhPerKm, speed]);
  // Once booking starts, the plan stays as booked: its own bookings take those slots, so planning
  // again would move the stops.
  const [frozen, setFrozen] = useState<{ inputs: string; plan: TripPlan } | null>(null);
  const live: TripPlan | null = useMemo(() => {
    const from = CITIES.find((c) => c.name === fromName), to = CITIES.find((c) => c.name === toName);
    if (!network || !vehicle || !from || !to || from === to) return null;
    return planTrip({
      net: network, vehicle, from, to, depart, now: new Date(minute * 60_000),
      startSoc: Math.min(100, Math.max(5, Number(startPct) || 90)) / 100,
      kwhPerKm: Number(kwhPerKm) > 0 ? Number(kwhPerKm) : undefined,
      speedKmh: Number(speed) >= 30 && Number(speed) <= 90 ? Number(speed) : undefined,
    });
  }, [network, vehicle, fromName, toName, depart, minute, startPct, kwhPerKm, speed]);
  const plan = frozen && frozen.inputs === inputs ? frozen.plan : live;
  // New inputs mean a new plan with nothing booked from it yet.
  useEffect(() => { setBooked([]); setFrozen(null); }, [inputs]);

  const bookAll = async () => {
    if (!plan || !vehicle || !fleetId) return;
    setFrozen({ inputs, plan });
    setBooking(true);
    const results: (string | { error: string })[] = [];
    for (const [i, s] of plan.stops.entries()) {
      if (typeof booked[i] === "string") { results.push(booked[i]); continue; }
      try {
        const row = await api<BookingRow>("POST", `/fleets/${fleetId}/bookings`, {
          vehicle_id: vehicle.id, driver_id: driverId || null, cpo_country_code: s.bl.country_code, cpo_party_id: s.bl.party_id,
          booking_location_id: s.bl.id, start_at: s.slot.start.toISOString(), end_at: s.slot.end.toISOString(), power_required_kw: null,
          notes: `Trip ${fromName} to ${toName}, stop ${i + 1} of ${plan.stops.length}`,
        });
        upsertBooking(row);
        results.push(row.reservation_status === "FAILED" ? { error: "The operator didn't accept this slot" } : row.id);
      } catch (e) {
        results.push({ error: e instanceof ApiFailure ? e.message : "Couldn't send the booking request" });
      }
      setBooked([...results]);
    }
    setBooking(false);
    const ok = results.filter((r) => typeof r === "string").length;
    toast(ok === plan.stops.length ? `All ${ok} stops requested` : `${ok} of ${plan.stops.length} stops requested`, ok === plan.stops.length ? "info" : "bad");
  };
  const allBooked = !!plan && plan.stops.length > 0 && plan.stops.every((_, i) => typeof booked[i] === "string");

  if (active.length === 0) {
    return <div className="page"><div className="panel"><Empty icon="route" title="Add a truck first" action={<a className="btn primary" href={href("/fleet", { add: 1 })}>Add vehicle</a>}>Trips are planned for one truck: its battery, connectors and size decide where it can charge.</Empty></div></div>;
  }

  return (
    <div className="page trip">
      <div className="page-head">
        <div>
          <a className="xs muted back-link" href={href("/book")}><Icon name="chevronLeft" size="sm" />Book</a>
          <h1>Plan a trip</h1>
          <div className="sub">Charging stops along a long run, lined up with the driver's breaks, booked in one go.</div>
        </div>
      </div>

      <div className="trip-grid">
        <section className="panel trip-form">
          <div className="panel-body stack gap-16">
            <Field label="Truck">{(id) => (
              <select id={id} className="select" value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
                {active.map((v) => <option key={v.id} value={v.id}>{v.plate}, {v.name}{v.battery_kwh ? ` (${v.battery_kwh} kWh)` : ""}</option>)}
              </select>
            )}</Field>
            <div className="trip-two">
              <Field label="From">{(id) => <select id={id} className="select" value={fromName} onChange={(e) => setFromName(e.target.value)}>{PLACES.map((c) => <option key={c.name}>{c.name}</option>)}</select>}</Field>
              <Field label="To">{(id) => <select id={id} className="select" value={toName} onChange={(e) => setToName(e.target.value)}>{PLACES.map((c) => <option key={c.name}>{c.name}</option>)}</select>}</Field>
            </div>
            <div className="trip-two">
              <Field label="Leaves on">{(id) => <input id={id} className="input" type="date" value={date} min={localDateKey(now, DEFAULT_TZ)} onChange={(e) => setDate(e.target.value)} />}</Field>
              <Field label="At">{(id) => <input id={id} className="input" type="time" step={900} value={time} onChange={(e) => setTime(e.target.value)} />}</Field>
            </div>
            <Field label="Battery when it leaves (%)">{(id) => <input id={id} className="input" inputMode="numeric" value={startPct} onChange={(e) => setStartPct(e.target.value)} />}</Field>
            <Field label="Driver" hint="Optional. Gets the pass for every stop.">{(id) => (
              <select id={id} className="select" value={driverId} onChange={(e) => setDriverId(e.target.value)}>
                <option value="">Not assigned yet</option>
                {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}</Field>
            <details className="disclose">
              <summary>Assumptions</summary>
              <div className="stack gap-12" style={{ marginTop: 12 }}>
                <Field label="Energy use (kWh per km)" hint={`Default for this truck: ${defaultKpk}`}>{(id) => <input id={id} className="input" inputMode="decimal" placeholder={String(defaultKpk)} value={kwhPerKm} onChange={(e) => setKwhPerKm(e.target.value)} />}</Field>
                <Field label="Average speed (km/h)" hint="Including traffic; HGVs are limited to 56 mph.">{(id) => <input id={id} className="input" inputMode="numeric" value={speed} onChange={(e) => setSpeed(e.target.value)} />}</Field>
                <p className="xs muted">Distance is the straight line plus 20% for roads. Stops charge to 80% and last at least 45 minutes, so each one covers the break due after 4 h 30 of driving. The truck arrives with at least 15%.</p>
              </div>
            </details>
          </div>
        </section>

        <section className="panel trip-plan" aria-live="polite">
          {!plan ? (
            <Empty icon="route" title={fromName === toName ? "Pick two different places" : "Planning…"} />
          ) : (
            <>
              <div className="trip-summary">
                <div><b className="num">{miles(plan.totalKm)} miles</b><span className="xs muted">about {fmtDuration(plan.drivingMin)} driving</span></div>
                <div><b className="num">{plan.stops.length}</b><span className="xs muted">{plan.stops.length === 1 ? "charging stop" : "charging stops"}</span></div>
                <div><b className="num">{plan.ok ? fmtTime(plan.arriveAt) : "—"}</b><span className="xs muted">{plan.ok ? `arrives ${fmtDay(plan.arriveAt, now).toLowerCase()}, ${pct(plan.arriveSoc)}` : "can't finish"}</span></div>
              </div>
              <ol className="trip-steps">
                <li className="trip-end"><span className="trip-dot" aria-hidden="true" /><div><b>Leave {fromName}</b><div className="xs muted">{fmtDay(depart, now)}, {fmtTime(depart)} · battery {pct(Math.min(100, Math.max(5, Number(startPct) || 90)) / 100)}</div></div></li>
                {plan.stops.map((s, i) => {
                  const r = booked[i];
                  const row = typeof r === "string" ? bookings.find((b) => b.id === r) : null;
                  return (
                    <li key={`${s.siteKey}-${i}`} className="trip-stop">
                      <span className="trip-dot charge" aria-hidden="true"><Icon name="zap" size="sm" /></span>
                      <div className="trip-card">
                        <div className="row gap-8 wrap" style={{ alignItems: "center" }}>
                          <b className="grow">{s.name}</b>
                          {s.assessment.zeroTouch && <span className="tag ok">No card needed</span>}
                          {row && <StatusBadge booking={row} />}
                        </div>
                        <div className="small">{fmtDay(s.slot.start, now)}, {fmtRange(s.slot.start, s.slot.end)}{s.waitMin > 5 ? ` · waits ${s.waitMin} min` : ""}</div>
                        <div className="xs muted">{miles(s.legKm)} miles from the last stop · battery {pct(s.socArrive)} → {pct(s.socLeave)}{s.assessment.usableKw ? ` · up to ${s.assessment.usableKw} kW` : ""} · {s.operator}</div>
                        {typeof r === "object" && r && <div className="xs" style={{ color: "var(--bad)" }} role="alert">{r.error}</div>}
                        {row && <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={() => navigate("/bookings", { open: row.id })}>Open booking</button>}
                      </div>
                    </li>
                  );
                })}
                {plan.ok ? (
                  <li className="trip-end"><span className="trip-dot end" aria-hidden="true" /><div><b>Arrive {toName}</b><div className="xs muted">{fmtDay(plan.arriveAt, now)}, about {fmtTime(plan.arriveAt)} · battery {pct(plan.arriveSoc)}</div></div></li>
                ) : (
                  <li className="trip-end"><span className="trip-dot bad" aria-hidden="true" /><div><b>Can't reach {toName}</b><div className="xs" style={{ color: "var(--bad)" }}>{plan.problem}</div></div></li>
                )}
              </ol>
              {plan.ok && plan.stops.length > 0 && vehicle && (
                <div className="trip-foot">
                  <Plate plate={vehicle.plate} size="sm" />
                  <span className="grow small muted">{allBooked ? "Every stop is requested. Operators confirm each one." : `Requests ${plan.stops.length} ${plan.stops.length === 1 ? "booking" : "bookings"} at the times shown.`}</span>
                  <button className="btn primary" disabled={booking || allBooked} onClick={() => void bookAll()}>
                    {booking ? <Spinner /> : <Icon name="book" size="sm" />}{allBooked ? "All booked" : booked.some((x) => typeof x === "object") ? "Retry the rest" : `Book ${plan.stops.length === 1 ? "this stop" : `all ${plan.stops.length} stops`}`}
                  </button>
                </div>
              )}
              {plan.ok && plan.stops.length === 0 && <p className="small muted trip-foot">No charging needed: the truck gets there on its own battery.</p>}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
