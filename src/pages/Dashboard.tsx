import { useMemo, useState } from "react";
import type { BookingRow } from "../../shared/model";
import { CANCEL_REASON_LABEL, VEHICLE_TYPE_LABEL } from "../../shared/booking/labels";
import { useApp } from "../app/state";
import { fmtDateTime, fmtDay, fmtKw, fmtKwh, fmtLongDate, fmtMoney, fmtRange, fmtRelative, fmtTime, greeting } from "../app/format";
import { findLocation, operatorFor, shortSiteName } from "../app/network";
import { href, navigate } from "../app/router";
import { marginAt, priceLine } from "../../shared/billing";
import { change, computeKpis, fleetOverview, keptRate, pricePerKwh, recentCharges, type TruckOverview } from "../app/kpis";
import { LaneBoard } from "../components/LaneBoard";
import { Sparkline } from "../components/Sparkline";
import { BatteryMeter } from "../components/Battery";
import { Empty, Icon, Modal, Plate, StatusBadge } from "../ui/ui";
import { ChargeStory } from "../components/art/ChargeStory";
import { TruckArt } from "../components/art/Mini";
import { truckKindOf } from "../components/art/scene";
import { MfaEnrol } from "./Security";

const DISMISS_KEY = "depotcharge.dismissed";

function readDismissed(): string[] {
  try { return JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]"); } catch { return []; }
}

const NUM = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const pct = (v: number) => `${Math.round(v * 100)}%`;

export function DashboardPage({ openBooking }: { openBooking(id: string): void }) {
  const { vehicles, bookings, network, now, loaded, fleet, me, backend, brand, refreshMe, toast } = useApp();
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);
  const [how, setHow] = useState(false);
  const [enrol, setEnrol] = useState(false);
  // Live accounts without a second factor get one gentle prompt (dismissable).
  const mfaNudge = !!backend.auth && !!me?.mfa && !me.mfa.enrolled && !dismissed.includes("mfa-nudge");

  const vehicle = (id: string | null) => vehicles.find((v) => v.id === id) ?? null;
  const siteName = (b: BookingRow) => {
    const loc = findLocation(network, b.cpo_country_code, b.cpo_party_id, b.location_id);
    return loc ? shortSiteName(loc, operatorFor(network, b.cpo_country_code, b.cpo_party_id, loc)) : b.location_id;
  };

  const margins = fleet?.margin_history;
  const kpis = useMemo(() => computeKpis(bookings, now, 7, undefined, margins), [bookings, now, margins]);
  const trucks = useMemo(() => fleetOverview(vehicles, bookings, now), [vehicles, bookings, now]);
  const recent = useMemo(() => recentCharges(bookings, 5), [bookings]);

  const attention = useMemo(() => {
    const since = now.getTime() - 36 * 3_600_000;
    return bookings
      .filter((b) => !dismissed.includes(b.id) && new Date(b.updated_at).getTime() > since)
      .filter((b) => b.reservation_status === "REJECTED" || b.reservation_status === "FAILED" || b.reservation_status === "NO_SHOW"
        || (b.reservation_status === "CANCELED" && b.booking?.canceled?.who_canceled === "CPO"))
      .slice(0, 4);
  }, [bookings, dismissed, now]);

  const upcoming = bookings
    .filter((b) => (b.reservation_status === "RESERVED" || b.reservation_status === "PENDING") && new Date(b.end_at) > now)
    .slice(0, 6);
  const todayCount = bookings.filter((b) => fmtDay(b.start_at, now) === "Today" && !["CANCELED", "REJECTED", "FAILED"].includes(b.reservation_status)).length;

  const dismiss = (id: string) => {
    const next = [...dismissed, id].slice(-200);
    setDismissed(next);
    try { localStorage.setItem(DISMISS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const reason = (b: BookingRow) => {
    const v = vehicle(b.vehicle_id);
    const who = `${v?.plate ?? b.plate} at ${siteName(b)}`;
    switch (b.reservation_status) {
      case "CANCELED": return `${operatorFor(network, b.cpo_country_code, b.cpo_party_id)} cancelled ${who}: ${CANCEL_REASON_LABEL[b.booking!.canceled!.cancellation_reason].toLowerCase()}`;
      case "REJECTED": return `${who} wasn't accepted. The slot had gone`;
      case "NO_SHOW": return `${who} was released as a no-show`;
      default: return `${who} couldn't be booked`;
    }
  };

  const hasHistory = kpis.current.sessions + kpis.previous.sessions + kpis.current.noShows + kpis.previous.noShows > 0;
  const charging = trucks.filter((t) => t.state === "charging");
  const nextArrival = trucks.map((t) => t.state === "due" ? t.current : t.next).filter(Boolean).sort((a, b) => a!.start_at.localeCompare(b!.start_at))[0] ?? null;

  return (
    <div className="page dashboard">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="sub">{greeting(now)}. {fmtLongDate(now)}{loaded.bookings ? `. ${todayCount} ${todayCount === 1 ? "booking" : "bookings"} today` : ""}.</div>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => setHow(true)}><Icon name="circleHelp" size="sm" />How charging works</button>
          <a className="btn primary" href={href("/book")}><Icon name="book" size="sm" />Book a slot</a>
        </div>
      </div>

      {attention.length > 0 && (
        <div className="attention" role="region" aria-label="Needs attention">
          {attention.map((b) => (
            <div className="attention-item" key={b.id}>
              <Icon name="alert" />
              <div className="grow">
                <div>{reason(b)}</div>
                <div className="xs muted">{fmtDay(b.start_at, now)}, {fmtRange(b.start_at, b.end_at)}. Updated {fmtRelative(b.updated_at, now)}.</div>
              </div>
              <button className="btn sm" onClick={() => navigate("/book", { vehicle: b.vehicle_id, at: b.start_at, duration: Math.round((new Date(b.end_at).getTime() - new Date(b.start_at).getTime()) / 60000) })}>Rebook</button>
              <button className="btn sm ghost" onClick={() => dismiss(b.id)}>Dismiss</button>
            </div>
          ))}
        </div>
      )}

      {mfaNudge && (
        <div className="attention nudge" role="region" aria-label="Account security">
          <div className="attention-item">
            <Icon name="shieldCheck" />
            <div className="grow">
              <div>Turn on two-step verification</div>
              <div className="xs muted">A code from your phone at sign-in means a stolen password isn't enough. If your organisation is working towards Cyber Essentials, it's required for every cloud service you use.</div>
            </div>
            <button className="btn sm primary" onClick={() => setEnrol(true)}>Set up</button>
            <button className="btn sm ghost" onClick={() => dismiss("mfa-nudge")}>Not now</button>
          </div>
        </div>
      )}
      {enrol && backend.auth && (
        <Modal title="Set up two-step verification" onClose={() => setEnrol(false)}>
          <MfaEnrol auth={backend.auth} label={`${brand.name} (${me?.user.email ?? "account"})`} onCancel={() => setEnrol(false)} onDone={() => { setEnrol(false); void refreshMe(); toast("Two-step verification is on"); }} />
        </Modal>
      )}

      {loaded.bookings && vehicles.length > 0 && (
        <section className="kpis" aria-label={`Key figures, last ${kpis.days} days`}>
          <KpiTile
            label="Energy delivered"
            value={hasHistory ? NUM.format(kpis.current.kwh) : "0"}
            unit="kWh"
            delta={change(kpis.current.kwh, kpis.previous.kwh)}
            tone="neutral"
            sub={`${kpis.current.sessions} ${kpis.current.sessions === 1 ? "charge" : "charges"}, last ${kpis.days} days`}
            spark={{ title: "Energy per day", format: (v) => fmtKwh(v), points: kpis.daily.map((d) => ({ label: fmtDay(d.start, now), value: d.kwh })), split: kpis.days }}
          />
          <KpiTile
            label="Charging spend"
            value={fmtMoney(Math.round(kpis.current.cost), kpis.currency)}
            unit="ex VAT"
            delta={change(kpis.current.cost, kpis.previous.cost)}
            tone="neutral"
            sub={pricePerKwh(kpis.current) != null ? `${fmtMoney(Math.round(pricePerKwh(kpis.current)! * 100) / 100, kpis.currency)} per kWh on average` : "No charge records yet"}
            spark={{ title: "Spend per day", format: (v) => fmtMoney(Math.round(v), kpis.currency), points: kpis.daily.map((d) => ({ label: fmtDay(d.start, now), value: d.cost })), split: kpis.days }}
          />
          <KpiTile
            label="Bookings kept"
            value={keptRate(kpis.current) != null ? pct(keptRate(kpis.current)!) : "—"}
            delta={keptRate(kpis.current) != null && keptRate(kpis.previous) != null ? keptRate(kpis.current)! - keptRate(kpis.previous)! : null}
            deltaAsPoints
            tone="up-good"
            sub={keptSummary(kpis.current)}
          />
          <KpiTile
            label="On charge now"
            value={String(kpis.chargingNow)}
            unit={kpis.chargingNow === 1 ? "truck" : "trucks"}
            sub={charging.length
              ? `${fmtKw(kpis.liveKw)} drawn now${charging.length === 1 && charging[0].current ? ` at ${siteName(charging[0].current).replace(/\s*\(.*\)$/, "")}` : ""}`
              : nextArrival ? `Next: ${vehicle(nextArrival.vehicle_id)?.name ?? nextArrival.plate}, ${fmtDateTime(nextArrival.start_at, now)}` : "Nothing booked"}
            sub2={charging.length && nextArrival ? `Next arrival: ${vehicle(nextArrival.vehicle_id)?.name ?? nextArrival.plate}, ${fmtDateTime(nextArrival.start_at, now)}` : undefined}
            live={charging.length > 0}
          />
        </section>
      )}

      {loaded.bookings && bookings.length === 0 && vehicles.length > 0 && (
        <section className="panel first-run" aria-label="How charging works">
          <div className="first-run-copy">
            <h2>Your drivers just turn up</h2>
            <p className="small muted">Book a slot and the operator gets the truck's plate and charging ID. At the site the barrier opens for the plate and the charger recognises the truck, so drivers need no cards or apps.</p>
            <div className="row gap-8 wrap"><a className="btn primary" href={href("/book")}><Icon name="book" size="sm" />Book the first slot</a></div>
          </div>
          <ChargeStory audience="planner" truck={truckKindOf(vehicles[0]?.vehicle_type)} start={vehicles[0]?.start_method ?? "PLUG_AND_CHARGE"} plate={vehicles[0]?.plate ?? "PN74 EVH"} />
        </section>
      )}

      {loaded.fleet && vehicles.length === 0 ? (
        <div className="panel">
          <Empty art={<TruckArt label="" />} title="Add your first vehicle" action={<a className="btn primary" href={href("/fleet", { add: 1 })}>Add vehicle</a>}>
            Bookings are made per truck: its plate opens the gate and its charging ID starts the charger.
          </Empty>
        </div>
      ) : (
        <>
          <section className="section" aria-labelledby="fleet-h">
            <div className="section-head">
              <h2 id="fleet-h">Your fleet</h2>
              <span className="right xs muted">Battery levels come from the charger while a truck is plugged in</span>
            </div>
            <div className="truck-grid">
              {trucks.map((t) => <TruckCard key={t.vehicle.id} t={t} siteName={siteName} onOpen={openBooking} />)}
            </div>
          </section>

          <section className="section" aria-labelledby="plan-h">
            <div className="section-head"><h2 id="plan-h">Today's plan</h2><span className="right xs muted">Pick an empty stretch of a lane to book that truck</span></div>
            <LaneBoard
              vehicles={vehicles}
              bookings={bookings}
              network={network}
              now={now}
              onOpen={(b) => openBooking(b.id)}
              onBookAt={(v, at) => navigate("/book", { vehicle: v.id, at: at.toISOString() })}
            />
          </section>
        </>
      )}

      <div className="today-grid">
        <section className="panel">
          <div className="panel-head"><h2>Coming up</h2><a className="right small" href={href("/bookings")}>All bookings</a></div>
          {upcoming.length === 0 ? (
            <Empty art={<TruckArt label="" />} title="Nothing booked yet">Book a slot and it will appear here, with the pass to send your driver.</Empty>
          ) : (
            <ul className="list">
              {upcoming.map((b) => (
                <li key={b.id}>
                  <button className="booking-row compact" onClick={() => openBooking(b.id)}>
                    <span className="time">{fmtRange(b.start_at, b.end_at)}<span className="xs muted" style={{ display: "block", fontWeight: 400 }}>{fmtDay(b.start_at, now)}</span></span>
                    <span className="plate-cell"><Plate plate={vehicle(b.vehicle_id)?.plate ?? b.plate} size="sm" /></span>
                    <span className="site-cell ellipsis">{siteName(b)}</span>
                    <span className="status-cell"><StatusBadge booking={b} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Recent charges</h2><span className="right xs muted">From operators' charge records</span></div>
          {recent.length === 0 ? (
            <Empty icon="zap" title="No charges yet">Each finished charge shows its energy, cost and battery level here.</Empty>
          ) : (
            <ul className="list">
              {recent.map((b) => (
                <li key={b.id}>
                  <button className="charge-row" onClick={() => openBooking(b.id)}>
                    <span className="plate-cell"><Plate plate={vehicle(b.vehicle_id)?.plate ?? b.plate} size="sm" /></span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="ellipsis" style={{ display: "block" }}>{siteName(b)}</span>
                      <span className="xs muted">{fmtDateTime(b.cdr?.end_date_time ?? b.session?.end_date_time ?? b.end_at, now)}{b.session?.soc != null && b.session.soc_start != null ? `. Battery ${Math.round(b.session.soc_start)}% to ${Math.round(b.session.soc)}%` : ""}</span>
                    </span>
                    <span className="charge-figs">
                      <span className="num">{fmtKwh(b.cdr?.total_energy ?? b.session?.kwh ?? 0)}</span>
                      <span className="xs muted num">{b.cdr ? fmtMoney(priceLine(b.cdr, marginAt(margins, b.cdr.end_date_time)).net, b.cdr.currency) : "Awaiting record"}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {how && (
        <Modal title="How charging works" onClose={() => setHow(false)} wide>
          <ChargeStory audience="planner" truck={truckKindOf(vehicles[0]?.vehicle_type)} start={vehicles[0]?.start_method ?? "PLUG_AND_CHARGE"} plate={vehicles[0]?.plate ?? "PN74 EVH"} />
        </Modal>
      )}
      {fleet && !fleet.desk_phone && vehicles.length > 0 && (
        <p className="small muted" style={{ marginTop: 18 }}>
          <Icon name="info" size="sm" /> Add your fleet desk number in <a href={href("/settings")}>Settings</a> so drivers can call you from their pass.
        </p>
      )}
    </div>
  );
}

function keptSummary(p: { kept: number; noShows: number; operatorCancels: number; fleetCancels: number }): string {
  const visits = p.kept + p.noShows;
  if (!visits) return "No visits due yet";
  const parts = [`${p.kept} of ${visits} visits`];
  if (p.noShows) parts.push(`${p.noShows} no-show${p.noShows === 1 ? "" : "s"}`);
  if (p.operatorCancels) parts.push(`${p.operatorCancels} cancelled by operators`);
  return parts.join(", ");
}

function KpiTile({ label, value, unit, delta, deltaAsPoints, tone, sub, sub2, spark, live }: {
  label: string;
  value: string;
  unit?: string;
  delta?: number | null;
  deltaAsPoints?: boolean;
  /** Whether a rise is good news (green), bad news, or just a change (neutral ink). */
  tone?: "neutral" | "up-good" | "up-bad";
  sub?: string;
  sub2?: string;
  spark?: { title: string; points: { label: string; value: number }[]; split: number; format(v: number): string };
  live?: boolean;
}) {
  const d = delta ?? null;
  const flat = d != null && Math.abs(d) < 0.005;
  const dir = d == null || flat ? "flat" : d > 0 ? "up" : "down";
  const good = tone === "up-good" ? dir === "up" : tone === "up-bad" ? dir === "down" : null;
  const deltaText = d == null ? null : flat ? "No change" : `${d > 0 ? "+" : "−"}${deltaAsPoints ? `${Math.round(Math.abs(d) * 100)} pts` : `${Math.round(Math.abs(d) * 100)}%`}`;
  return (
    <div className={`kpi${live ? " live" : ""}`}>
      <div className="kpi-label">{live && <span className="live-dot" aria-hidden="true" />}{label}</div>
      <div className="kpi-value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {deltaText && (
        <div className={`kpi-delta ${dir} ${good == null || dir === "flat" ? "" : good ? "good" : "bad"}`}>
          {dir !== "flat" && <Icon name={dir === "up" ? "trendUp" : "trendDown"} size="sm" />}
          <span>{deltaText}</span><span className="muted"> vs prior 7 days</span>
        </div>
      )}
      {sub && <div className="kpi-sub">{sub}</div>}
      {sub2 && <div className="kpi-sub">{sub2}</div>}
      {spark && <Sparkline {...spark} />}
    </div>
  );
}

function TruckCard({ t, siteName, onOpen }: { t: TruckOverview; siteName(b: BookingRow): string; onOpen(id: string): void }) {
  const { now } = useApp();
  const v = t.vehicle;
  const b = t.battery;
  const target = t.current ?? t.next;
  const site = (x: BookingRow) => siteName(x).replace(/\s*\(.*\)$/, "");
  const stateLabel: Record<TruckOverview["state"], { text: string; tone: string }> = {
    charging: { text: "Charging", tone: "ok" },
    due: { text: "Due on site", tone: "info" },
    booked: { text: "Booked", tone: "neutral" },
    idle: { text: "No booking", tone: "neutral" },
    inactive: { text: "Inactive", tone: "neutral" },
  };
  const s = stateLabel[t.state];

  let batteryText: string;
  if (!b) batteryText = t.state === "charging" ? "Waiting for the first battery reading" : "No battery reading yet";
  else if (b.live) {
    const parts = [b.powerKw ? `${fmtKw(b.powerKw)}` : "Charging"];
    if (b.soc >= 99.5) parts.push("full");
    else if (b.eta && b.target) parts.push(`${b.target}% by ${fmtTime(b.eta)}${b.inTime === false ? ", after the slot ends" : ""}`);
    batteryText = parts.join(", ");
  } else batteryText = `When it left ${t.lastCharge ? site(t.lastCharge) : "its last charge"}, ${fmtDateTime(b.at, now)}`;

  return (
    <article className={`truck-card state-${t.state}`}>
      <header className="truck-head">
        <Plate plate={v.plate} size="sm" />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="truck-name ellipsis">{v.name}</span>
          <span className="xs muted ellipsis" style={{ display: "block" }}>{VEHICLE_TYPE_LABEL[v.vehicle_type] ?? v.vehicle_type}{v.battery_kwh ? `, ${NUM.format(v.battery_kwh)} kWh battery` : ""}</span>
        </span>
        <span className={`status ${s.tone}`}>{s.text}</span>
      </header>

      <div className="truck-battery">
        <div className="row gap-8" style={{ alignItems: "baseline" }}>
          <span className="battery-figure">{b ? `${Math.round(b.soc)}%` : "—"}</span>
          <span className="xs muted grow" style={{ minWidth: 0 }}>
            {b && b.soc < 20 && <span className="tag bad" style={{ marginRight: 6 }}><Icon name="batteryLow" size="sm" />Low</span>}
            {b?.live ? <span className="sr-only">Live: </span> : b ? <span className="sr-only">Last known: </span> : null}
            {batteryText}
          </span>
        </div>
        {b ? <BatteryMeter soc={b.soc} live={b.live} label={`${v.name} battery`} /> : <div className="battery-meter none" aria-hidden="true"><div className="bm-track" /></div>}
      </div>

      <div className="truck-foot">
        {t.state === "charging" && t.current ? (
          <span className="small ellipsis grow">
            <Icon name="zap" size="sm" />{site(t.current)}, until {fmtTime(t.current.end_at)}
          </span>
        ) : target ? (
          <span className="small ellipsis grow">
            <Icon name="clock" size="sm" />{fmtDateTime(target.start_at, now)}, {site(target)}
          </span>
        ) : (
          <span className="small muted grow">{t.problem ? "Last booking needs attention" : "Nothing booked"}</span>
        )}
        {target ? (
          <button className="btn sm" onClick={() => onOpen(target.id)}>Open</button>
        ) : v.active ? (
          <a className="btn sm" href={href("/book", { vehicle: v.id })}>Book</a>
        ) : null}
      </div>
    </article>
  );
}
