import { useEffect, useState } from "react";
import type { BookingEvent, BookingRow } from "../../shared/model";
import type { CanceledReason } from "../../shared/ocpi/types";
import { CANCEL_REASON_LABEL, FLEET_CANCEL_REASONS, START_METHOD_LABEL } from "../../shared/booking/labels";
import { suggestSlots } from "../../shared/booking/slots";
import { canChange, cancelTerms, deadlines } from "../../shared/booking/terms";
import { summarizeTariffs } from "../../shared/booking/tariffs";
import { MINUTE, startOfLocalDay } from "../../shared/util";
import { useApp } from "../app/state";
import { DEFAULT_VAT_RATE, marginAt, priceLine } from "../../shared/billing";
import { ApiFailure } from "../app/backend";
import { DEFAULT_TZ, fmtDateTime, fmtDay, fmtDuration, fmtKwh, fmtMoney, fmtRange, fmtRelative, fmtTime, sessionKw } from "../app/format";
import { findBookingLocation, findLocation, operatorFor, shortSiteName, tariffsFor } from "../app/network";
import { SlotPicker } from "../components/SlotPicker";
import { Drawer, Icon, Json, Plate, Seg, Spinner, StatusBadge } from "../ui/ui";
import { PassShare } from "./PassShare";
import { RebookSuggestion } from "../components/RebookSuggestion";
import { SmartChargingCard } from "../components/SmartCharging";
import { navigate } from "../app/router";
import { ChargeStory } from "../components/art/ChargeStory";
import { ChargingMini } from "../components/art/Mini";
import { accessKindOf, truckKindOf } from "../components/art/scene";

const EVENT_TONE: Record<string, string> = {
  RESERVED: "ok", CHANGE_ACCEPTED: "ok", FULFILLED: "info", SESSION_STARTED: "info", SESSION_COMPLETED: "ok", CDR_RECEIVED: "ok",
  AUTHORIZED: "info", PENDING: "pending", CHANGE_REQUESTED: "pending", CANCEL_REQUESTED: "pending", REQUESTED: "pending",
  REJECTED: "bad", FAILED: "bad", NO_SHOW: "bad", CANCELED: "bad", CHANGE_DECLINED: "bad", CANCEL_DECLINED: "bad", BAY_ASSIGNED: "info",
};

export function BookingDrawer({ id, onClose }: { id: string; onClose(): void }) {
  const { bookings, events, vehicles, drivers, network, now, api, toast, upsertBooking, fleetId, fleet, me, refreshBookings } = useApp();
  const b = bookings.find((x) => x.id === id) ?? null;
  const [mode, setMode] = useState<"none" | "change" | "cancel">("none");
  const [busy, setBusy] = useState<string | null>(null);
  const [newStart, setNewStart] = useState<Date | null>(null);
  const [newDur, setNewDur] = useState(45);
  const [reason, setReason] = useState<CanceledReason>("TRAFFIC");
  const [showHow, setShowHow] = useState(false);

  useEffect(() => {
    if (!b) return;
    setNewStart(new Date(b.start_at));
    setNewDur(Math.round((new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / MINUTE));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b?.id, b?.start_at, b?.end_at]);

  if (!b) {
    return (
      <Drawer title="Booking" onClose={onClose}>
        {bookings.length ? <p className="muted">This booking isn't in your fleet.</p> : <Spinner />}
      </Drawer>
    );
  }

  const loc = findLocation(network, b.cpo_country_code, b.cpo_party_id, b.location_id);
  const op = operatorFor(network, b.cpo_country_code, b.cpo_party_id, loc);
  const name = loc ? shortSiteName(loc, op) : b.location_id;
  const bl = findBookingLocation(network, b.cpo_country_code, b.cpo_party_id, b.booking_location_id);
  const tz = loc?.time_zone ?? DEFAULT_TZ;
  const vehicle = vehicles.find((v) => v.id === b.vehicle_id) ?? null;
  const terms = b.booking?.booking_terms ?? bl?.booking_terms ?? null;
  const dl = deadlines(terms, b.start_at, b.end_at);
  const change = canChange(terms, b.start_at, now);
  const cancel = cancelTerms(terms, b.start_at, now);
  const tariff = bl ? summarizeTariffs(tariffsFor(network, bl)) : null;
  const evse = b.evse_uid ? loc?.evses?.find((e) => e.uid === b.evse_uid) : null;
  const open = b.reservation_status === "RESERVED" || b.reservation_status === "PENDING";
  const isSim = !!network?.operators.find((o) => o.country_code === b.cpo_country_code && o.party_id === b.cpo_party_id)?.is_simulator;
  const mine = events.filter((e) => e.booking_id === b.id).sort((x, y) => x.at.localeCompare(y.at));
  const durMin = Math.round((new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / MINUTE);

  const run = async (label: string, fn: () => Promise<BookingRow | unknown>, done?: string) => {
    setBusy(label);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "reservation_status" in (r as BookingRow)) upsertBooking(r as BookingRow);
      if (done) toast(done);
      setMode("none");
      await refreshBookings();
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "That didn't work", "bad");
    } finally {
      setBusy(null);
    }
  };

  const setDriver = (driverId: string) => run("driver", () => api("PATCH", `/fleets/${fleetId}/bookings/${b.id}`, { driver_id: driverId || null }), driverId ? "Driver assigned" : "Driver removed");
  const sim = (action: string, label: string, extra: Record<string, unknown> = {}) => run(action, () => api("POST", "/admin/simulator/action", { action, booking_id: b.id, ...extra }), label);

  return (
    <Drawer
      title={name}
      sub={<>{op}{loc ? `, ${loc.address}, ${loc.city}` : ""}</>}
      head={<div className="row gap-8" style={{ marginBottom: 6 }}><StatusBadge booking={b} />{b.pending_action && <span className="xs muted">{b.pending_action.kind === "CHANGE" ? "Change requested" : "Cancellation requested"} {fmtRelative(b.pending_action.requested_at, now)}</span>}</div>}
      onClose={onClose}
      foot={open ? (
        <>
          <button className="btn" disabled={!change.ok || !!b.pending_action || b.reservation_status !== "RESERVED"} title={change.reason} onClick={() => setMode(mode === "change" ? "none" : "change")}><Icon name="clock" size="sm" />Change time</button>
          <button className="btn danger" disabled={!!b.pending_action} onClick={() => setMode(mode === "cancel" ? "none" : "cancel")}><Icon name="x" size="sm" />Cancel booking</button>
          {loc && <a className="btn ghost right" href={`https://www.google.com/maps/dir/?api=1&destination=${loc.coordinates.latitude},${loc.coordinates.longitude}`} target="_blank" rel="noreferrer"><Icon name="navigation" size="sm" />Directions</a>}
        </>
      ) : undefined}
    >
      <div className="stack gap-24">
        <div className="stack gap-6">
          <div className="small muted">{fmtDay(b.start_at, now, tz)}</div>
          <div className="bigtime">{fmtRange(b.start_at, b.end_at, tz)}</div>
          <div className="small muted">{fmtDuration(durMin)}{b.power_required_kw ? `, ${b.power_required_kw} kW requested` : ""}</div>
        </div>

        {mode === "change" && bl && (
          <div className="panel" style={{ background: "var(--surface-2)" }}>
            <div className="panel-body stack gap-12">
              <b>New time</b>
              <SlotPicker bl={bl} dayStart={startOfLocalDay(newStart ?? new Date(b.start_at), tz)} now={now} start={newStart} duration={newDur} onChange={setNewStart} tz={tz} ignoreBusy={{ start: new Date(b.start_at), end: new Date(b.end_at) }} />
              <div className="chips">
                {suggestSlots(bl, new Date(b.start_at), newDur, now, { count: 4, horizonMin: 6 * 60 }).map((s) => (
                  <button key={s.start.toISOString()} className="chip" aria-pressed={newStart?.getTime() === s.start.getTime()} onClick={() => setNewStart(s.start)}>{fmtTime(s.start, tz)}</button>
                ))}
              </div>
              <Seg label="Duration" value={String(newDur)} onChange={(v) => setNewDur(Number(v))} options={[30, 45, 60, 90, 120].filter((d) => d >= (terms?.min_booking_duration ?? 0) && d <= (terms?.max_booking_duration ?? 600)).map((d) => ({ value: String(d), label: fmtDuration(d) }))} />
              <div className="row gap-8">
                <button className="btn primary" disabled={!newStart || busy === "change"} onClick={() => newStart && run("change", () => api("POST", `/fleets/${fleetId}/bookings/${b.id}/change`, { start_at: newStart.toISOString(), end_at: new Date(newStart.getTime() + newDur * MINUTE).toISOString() }), "Change requested. Waiting for the operator")}>
                  {busy === "change" && <Spinner />}Request {newStart ? fmtRange(newStart, new Date(newStart.getTime() + newDur * MINUTE), tz) : "change"}
                </button>
                <button className="btn ghost" onClick={() => setMode("none")}>Keep current time</button>
              </div>
              <span className="hint">The current slot stays reserved until {op} accepts the new one.</span>
            </div>
          </div>
        )}

        {mode === "cancel" && (
          <div className="panel" style={{ background: "var(--surface-2)" }}>
            <div className="panel-body stack gap-12">
              <b>Cancel this booking?</b>
              <Seg<CanceledReason> label="Reason" value={reason} onChange={setReason} options={FLEET_CANCEL_REASONS.map((r) => ({ value: r, label: r === "NO_CANCELED" ? "Other" : CANCEL_REASON_LABEL[r] }))} />
              <div className="small">{cancel.free ? `Free until ${fmtDateTime(cancel.deadline, now, tz)}.` : `The free cancellation deadline passed at ${fmtTime(cancel.deadline, tz)}.${tariff?.cancelFee ? ` ${op} may charge ${fmtMoney(tariff.cancelFee, tariff.currency)}.` : ""}`}</div>
              <div className="row gap-8">
                <button className="btn danger" disabled={busy === "cancel"} onClick={() => run("cancel", () => api("POST", `/fleets/${fleetId}/bookings/${b.id}/cancel`, { reason }), "Booking cancelled")}>{busy === "cancel" && <Spinner />}Cancel booking</button>
                <button className="btn ghost" onClick={() => setMode("none")}>Keep booking</button>
              </div>
            </div>
          </div>
        )}

        {(b.session || b.cdr) && (
          <div className="panel">
            {b.session?.status === "ACTIVE" && (
              <div style={{ padding: "14px 16px 0" }}>
                <ChargingMini size="lg" truck={truckKindOf(vehicle?.vehicle_type)} kw={sessionKw(b, now)} label={`${vehicle?.plate ?? b.plate} charging`} />
              </div>
            )}
            <div className="panel-body row gap-24 wrap">
              <div><div className="xs muted">Energy</div><div className="bigtime md">{fmtKwh(b.cdr?.total_energy ?? b.session?.kwh ?? 0)}</div></div>
              {b.cdr && (() => {
                const p = priceLine(b.cdr, marginAt(fleet?.margin_history, b.cdr.end_date_time));
                return <div><div className="xs muted">You pay</div><div className="bigtime md">{fmtMoney(Math.round(p.net * (1 + DEFAULT_VAT_RATE) * 100) / 100, b.cdr.currency)}</div><div className="xs muted">{fmtMoney(p.net, b.cdr.currency)} ex. VAT{b.cdr.total_reservation_cost ? `, incl. ${fmtMoney(b.cdr.total_reservation_cost, b.cdr.currency)} booking fee` : ""}</div></div>;
              })()}
              <div><div className="xs muted">Session</div><div style={{ fontWeight: 600 }}>{b.session?.status === "ACTIVE" ? "Charging" : "Finished"}</div><div className="xs muted">Started {fmtTime(b.session?.start_date_time ?? b.start_at, tz)}{b.session?.end_date_time ? `, ended ${fmtTime(b.session.end_date_time, tz)}` : ""}</div></div>
            </div>
          </div>
        )}

        {(open || b.reservation_status === "FULFILLED" || b.smart_charging) && <SmartChargingCard booking={b} tz={tz} onChange={(r) => upsertBooking(r)} />}

        <dl className="kv">
          <dt>Truck</dt>
          <dd className="row gap-8 wrap"><Plate plate={vehicle?.plate ?? b.plate} />{vehicle?.name}</dd>
          <dt>Gate</dt>
          <dd>Opens for the number plate{b.booking?.access_information?.some((a) => a.method === "ACCESS_CODE") ? `, code ${b.booking?.access_information?.find((a) => a.method === "ACCESS_CODE")?.value ?? ""}` : ""}</dd>
          <dt>Charger start</dt>
          <dd>{vehicle ? `${START_METHOD_LABEL[vehicle.start_method]}, ID ${maskId(b.token_uid)}` : b.token_type}</dd>
          <dt>Bay</dt>
          <dd>{evse ? `${evse.physical_reference ?? evse.evse_id} (${evse.evse_id ?? evse.uid})` : "Assigned when the truck arrives"}</dd>
          <dt>Arrival</dt>
          <dd>From {fmtTime(dl.arriveFrom, tz)}{dl.noShowAt ? `. Released at ${fmtTime(dl.noShowAt, tz)} if not arrived` : ""}</dd>
          <dt>Driver</dt>
          <dd>
            <select className="select" style={{ height: 32 }} value={b.driver_id ?? ""} onChange={(e) => void setDriver(e.target.value)} disabled={busy === "driver"} aria-label="Driver">
              <option value="">Not assigned</option>
              {drivers.map((d) => <option key={d.id} value={d.id}>{d.name}{d.phone ? `, ${d.phone}` : ""}</option>)}
            </select>
          </dd>
          {b.notes && <><dt>Note</dt><dd>{b.notes}</dd></>}
        </dl>

        {(b.reservation_status === "REJECTED" || b.reservation_status === "FAILED" || b.reservation_status === "NO_SHOW" || (b.reservation_status === "CANCELED" && b.booking?.canceled?.who_canceled === "CPO"))
          && new Date(b.end_at).getTime() > now.getTime() - 6 * 3_600_000
          && <RebookSuggestion booking={b} onBooked={(id) => navigate("/bookings", { open: id })} />}

        {(open || b.reservation_status === "FULFILLED") && <PassShare booking={b} vehicle={vehicle} siteName={name} />}

        {open && (
          <details className="disclose" open={showHow} onToggle={(e) => setShowHow((e.currentTarget as HTMLDetailsElement).open)}>
            <summary><Icon name="chevronRight" size="sm" />What happens when the truck arrives</summary>
            {showHow && (
              <div style={{ marginTop: 10 }}>
                <ChargeStory
                  audience="planner"
                  truck={truckKindOf(vehicle?.vehicle_type)}
                  access={accessKindOf(terms?.supported_access_methods)}
                  start={vehicle?.start_method ?? (b.token_type === "EMAID" ? "PLUG_AND_CHARGE" : "AUTOCHARGE")}
                  plate={vehicle?.plate ?? b.plate}
                  maxKw={b.power_required_kw ?? 350}
                />
              </div>
            )}
          </details>
        )}

        {isSim && me?.is_admin && (open || b.session?.status === "ACTIVE") && (
          <div className="panel">
            <div className="panel-body stack gap-8">
              <div><b>Simulate at the site</b><div className="xs muted">The simulated operator sends real OCPI messages back: authorise, session, CDR.</div></div>
              <div className="row gap-8 wrap">
                {b.reservation_status === "RESERVED" && <button className="btn sm" disabled={!!busy} onClick={() => sim("arrive", "Truck recognised, charging started")}><Icon name="scan" size="sm" />Truck arrives</button>}
                {b.session?.status === "ACTIVE" && <button className="btn sm" disabled={!!busy} onClick={() => sim("finish", "Charging finished, charge record received")}><Icon name="battery" size="sm" />Finish charging</button>}
                {b.reservation_status === "RESERVED" && <button className="btn sm" disabled={!!busy} onClick={() => sim("no_show", "Marked as no-show")}><Icon name="timer" size="sm" />No-show</button>}
                {open && <button className="btn sm" disabled={!!busy} onClick={() => sim("cpo_cancel", "Operator cancelled the booking", { reason: "BROKEN_CHARGER" })}><Icon name="alert" size="sm" />Operator cancels</button>}
              </div>
            </div>
          </div>
        )}

        <section>
          <h3 style={{ marginBottom: 6 }}>Activity</h3>
          <ul className="timeline">
            {mine.map((e: BookingEvent) => (
              <li key={e.id} className={EVENT_TONE[e.kind] ?? ""}>
                <span className="mark" />
                <span>{e.message}</span>
                <span className="xs faint nowrap">{fmtDateTime(e.at, now, tz)}</span>
              </li>
            ))}
          </ul>
        </section>

        <details className="disclose">
          <summary><Icon name="chevronRight" size="sm" />OCPI details</summary>
          <div className="stack gap-12" style={{ marginTop: 8 }}>
            <dl className="kv">
              <dt>Operator party</dt><dd>{b.cpo_country_code}*{b.cpo_party_id}</dd>
              <dt>Booking id</dt><dd>{b.ocpi_id ?? "Not assigned yet"}</dd>
              <dt>Request id</dt><dd>{b.request_id}</dd>
              <dt>Authorisation ref.</dt><dd>{b.authorization_reference}</dd>
              <dt>BookingLocation</dt><dd>{b.booking_location_id}</dd>
            </dl>
            <div className="small muted">Booking (from {op})</div>
            <Json value={b.booking} />
            <div className="small muted">Last BookingRequest (sent by us)</div>
            <Json value={b.last_request} />
          </div>
        </details>
      </div>
    </Drawer>
  );
}

function maskId(id: string) {
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}
