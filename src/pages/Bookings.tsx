import { useMemo, useState } from "react";
import type { BookingRow } from "../../shared/model";
import { useApp } from "../app/state";
import { fmtDay, fmtLongDate, fmtRange } from "../app/format";
import { findLocation, operatorFor, shortSiteName } from "../app/network";
import { href } from "../app/router";
import { Avatar, Empty, Icon, Plate, Seg, StatusBadge } from "../ui/ui";
import { EmptyBayArt, TruckArt } from "../components/art/Mini";

type Tab = "upcoming" | "active" | "past" | "problems";

export function BookingsPage({ openBooking }: { openBooking(id: string): void }) {
  const { bookings, vehicles, drivers, network, now, loaded } = useApp();
  const [tab, setTab] = useState<Tab>("upcoming");
  const [q, setQ] = useState("");

  const siteName = (b: BookingRow) => {
    const loc = findLocation(network, b.cpo_country_code, b.cpo_party_id, b.location_id);
    return loc ? shortSiteName(loc, operatorFor(network, b.cpo_country_code, b.cpo_party_id, loc)) : b.location_id;
  };
  const vehicle = (id: string | null) => vehicles.find((v) => v.id === id);
  const driver = (id: string | null) => drivers.find((d) => d.id === id);

  const counts = useMemo(() => {
    const c = { upcoming: 0, active: 0, past: 0, problems: 0 };
    for (const b of bookings) c[bucket(b, now)]++;
    return c;
  }, [bookings, now]);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return bookings
      .filter((b) => bucket(b, now) === tab)
      .filter((b) => !term || [b.plate, siteName(b), vehicle(b.vehicle_id)?.name, driver(b.driver_id)?.name, b.authorization_reference].some((x) => x?.toLowerCase().includes(term)))
      .sort((a, b) => (tab === "past" ? b.start_at.localeCompare(a.start_at) : a.start_at.localeCompare(b.start_at)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings, tab, q, now, network, vehicles, drivers]);

  const groups = useMemo(() => {
    const m = new Map<string, BookingRow[]>();
    for (const b of list) {
      const k = fmtDay(b.start_at, now) === "Today" || fmtDay(b.start_at, now) === "Tomorrow" || fmtDay(b.start_at, now) === "Yesterday" ? fmtDay(b.start_at, now) : fmtLongDate(b.start_at);
      m.set(k, [...(m.get(k) ?? []), b]);
    }
    return [...m.entries()];
  }, [list, now]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Bookings</h1>
          <div className="sub">Every slot your fleet has requested, live from the operators.</div>
        </div>
        <div className="actions">
          <a className="btn" href={href("/statements")}><Icon name="fileText" size="sm" />Monthly statements</a>
          <a className="btn primary" href={href("/book")}><Icon name="book" size="sm" />Book a slot</a>
        </div>
      </div>
      <div className="row gap-12 wrap" style={{ marginBottom: 16 }}>
        <Seg<Tab> label="Show" value={tab} onChange={setTab} options={[
          { value: "upcoming", label: `Upcoming${counts.upcoming ? ` (${counts.upcoming})` : ""}` },
          { value: "active", label: `Charging${counts.active ? ` (${counts.active})` : ""}` },
          { value: "past", label: "Past" },
          { value: "problems", label: `Problems${counts.problems ? ` (${counts.problems})` : ""}` },
        ]} />
        <div className="right toolbar-search" style={{ position: "relative", minWidth: 220, flex: "0 1 300px" }}>
          <input className="input" placeholder="Search plate, site or driver" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search bookings" style={{ paddingLeft: 34 }} />
          <span style={{ position: "absolute", left: 10, top: 10, color: "var(--faint)" }}><Icon name="search" size="sm" /></span>
        </div>
      </div>
      {!loaded.bookings ? (
        <div className="panel"><div className="stack gap-8" style={{ padding: 16 }}>{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 40 }} />)}</div></div>
      ) : groups.length === 0 ? (
        <div className="panel">
          <Empty icon="bookings" art={!q && tab === "active" ? <EmptyBayArt label="" /> : !q && tab === "upcoming" ? <TruckArt label="" /> : undefined} title={q ? "No bookings match that search" : tab === "upcoming" ? "No upcoming bookings" : tab === "active" ? "No trucks charging" : tab === "problems" ? "No problems" : "No past bookings yet"}
            action={tab === "upcoming" && !q ? <a className="btn primary" href={href("/book")}>Book a slot</a> : undefined}>
            {tab === "problems" ? "Rejected, failed, no-show and operator-cancelled bookings show up here." : undefined}
          </Empty>
        </div>
      ) : groups.map(([day, rows]) => (
        <section className="day-group" key={day}>
          <h2>{day}</h2>
          <ul className="list panel">
            {rows.map((b) => (
              <li key={b.id}>
                <div className="booking-row" role="button" tabIndex={0} onClick={() => openBooking(b.id)} onKeyDown={(e) => { if (e.key === "Enter") openBooking(b.id); }}>
                  <span className="time">{fmtRange(b.start_at, b.end_at)}</span>
                  <span className="plate-cell"><Plate plate={vehicle(b.vehicle_id)?.plate ?? b.plate} /></span>
                  <span className="site-cell" style={{ minWidth: 0 }}>
                    <span className="ellipsis" style={{ display: "block", fontWeight: 560 }}>{siteName(b)}</span>
                    <span className="xs muted ellipsis" style={{ display: "block" }}>{operatorFor(network, b.cpo_country_code, b.cpo_party_id)}{b.session?.status === "ACTIVE" ? (b.session.kwh >= 1 ? `, ${Math.round(b.session.kwh)} kWh so far` : ", charging started") : b.cdr ? `, ${Math.round(b.cdr.total_energy)} kWh` : ""}</span>
                  </span>
                  <span className="driver-cell row gap-8 small muted">{driver(b.driver_id) ? <><Avatar name={driver(b.driver_id)!.name} />{driver(b.driver_id)!.name.split(" ")[0]}</> : "No driver"}</span>
                  <span className="status-cell"><StatusBadge booking={b} /></span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function bucket(b: BookingRow, now: Date): "upcoming" | "active" | "past" | "problems" {
  if (["REJECTED", "FAILED", "NO_SHOW"].includes(b.reservation_status) || (b.reservation_status === "CANCELED" && b.booking?.canceled?.who_canceled === "CPO")) return "problems";
  if (b.session?.status === "ACTIVE" || (b.reservation_status === "FULFILLED" && b.session?.status !== "COMPLETED" && new Date(b.end_at) > now)) return "active";
  if ((b.reservation_status === "RESERVED" || b.reservation_status === "PENDING") && new Date(b.end_at) > now) return "upcoming";
  return "past";
}
