import { useEffect, useMemo, useRef, useState } from "react";
import type { BookingRow, Vehicle } from "../../shared/model";
import type { BookingLocation } from "../../shared/ocpi/types";
import { ACCESS_LABEL, START_METHOD_LABEL, VEHICLE_TYPE_LABEL, connectorLabel } from "../../shared/booking/labels";
import { MIN_BOOKING_DAYS, bookableDays, availableWindows, checkSlot, durationLimits, suggestSlots } from "../../shared/booking/slots";
import { deadlines } from "../../shared/booking/terms";
import { estimateCost } from "../../shared/booking/tariffs";
import { MINUTE, ceilToStep, localDateKey, localToUtc, startOfLocalDay } from "../../shared/util";
import { CITIES } from "../map/ukmap";
import { useApp } from "../app/state";
import { DEFAULT_TZ, fmtDateTime, fmtDay, fmtDuration, fmtKw, fmtMiles, fmtMoney, fmtRange, fmtTime, initials } from "../app/format";
import { rankSites, type Site, type SiteOption } from "../app/network";
import { href, navigate, useRoute } from "../app/router";
import { NetworkMap, type MapPin } from "../components/NetworkMap";
import { SlotPicker } from "../components/SlotPicker";
import { ApiFailure } from "../app/backend";
import { Empty, Icon, Plate, Seg, Spinner, StatusBadge, Switch } from "../ui/ui";
import { PassShare } from "./PassShare";
import { ChargeStory } from "../components/art/ChargeStory";
import { TruckArt } from "../components/art/Mini";
import { accessKindOf, truckKindOf } from "../components/art/scene";

const TZ = DEFAULT_TZ;
const DURATIONS = [30, 45, 60, 90, 120, 180, 240, 360, 480, 600];

function localTimeOf(d: Date) {
  return fmtTime(d, TZ);
}
function atLocal(day: Date, hhmm: string) {
  const [y, m, dd] = localDateKey(new Date(day.getTime() + 12 * 60 * MINUTE), TZ).split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return localToUtc(y, m, dd, h || 0, mi || 0, TZ);
}

export function BookPage() {
  const { vehicles, drivers, network, now, api, toast, upsertBooking, bookings, loaded, fleetId, refreshNetwork } = useApp();
  const route = useRoute();
  const p = route.params;
  const active = vehicles.filter((v) => v.active);

  const initialAt = p.get("at") ? new Date(p.get("at")!) : null;
  const [vehicleId, setVehicleId] = useState<string | null>(p.get("vehicle"));
  const [day, setDay] = useState<Date>(() => startOfLocalDay(initialAt && initialAt > now ? initialAt : now, TZ));
  const [arrive, setArrive] = useState<string>(() => localTimeOf(ceilToStep(initialAt && initialAt > now ? initialAt : new Date(now.getTime() + 60 * MINUTE), 15)));
  const [duration, setDuration] = useState<number>(() => Number(p.get("duration")) || 45);
  const [nearName, setNearName] = useState<string>("");
  const [zeroTouchOnly, setZeroTouchOnly] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [optionId, setOptionId] = useState<string | null>(null);
  const [start, setStart] = useState<Date | null>(null);
  const [power, setPower] = useState<number | null>(null);
  const [driverId, setDriverId] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);
  const [mobileView, setMobileView] = useState<"list" | "map">("list");
  const [showUnfit, setShowUnfit] = useState(false);
  const sideRef = useRef<HTMLDivElement>(null);

  // Start with a truck that doesn't already have charge lined up.
  useEffect(() => {
    if (vehicleId || !active.length || !loaded.bookings) return;
    const busy = new Set(bookings
      .filter((b) => b.session?.status === "ACTIVE" || ((b.reservation_status === "PENDING" || b.reservation_status === "RESERVED") && new Date(b.end_at) > now))
      .map((b) => b.vehicle_id));
    setVehicleId((active.find((v) => !busy.has(v.id)) ?? active[0]).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.length, vehicleId, loaded.bookings]);
  useEffect(() => { void refreshNetwork().catch(() => undefined); }, [refreshNetwork]);

  const vehicle = vehicles.find((v) => v.id === vehicleId) ?? null;
  const near = CITIES.find((c) => c.name === nearName) ?? null;
  const desired = useMemo(() => {
    const d = atLocal(day, arrive);
    return d < now ? ceilToStep(now, 15) : d;
  }, [day, arrive, now]);

  const sites = useMemo(() => (network && vehicle ? rankSites(network, { vehicle, desired, durationMin: duration, near, now }) : []), [network, vehicle, desired, duration, near, now]);
  const shown = sites.filter((s) => s.fits && (!zeroTouchOnly || s.zeroTouch));
  const needsAction = zeroTouchOnly ? sites.filter((s) => s.fits && !s.zeroTouch) : [];
  const unfit = sites.filter((s) => !s.fits);
  const site = sites.find((s) => s.key === selectedKey) ?? null;
  const option: SiteOption | null = site?.options.find((o) => o.bl.id === optionId) ?? site?.best ?? null;
  const bl = option?.bl ?? null;
  const lim = bl ? durationLimits(bl) : null;

  // Today up to the last day any operator publishes availability for (a week minimum, four weeks maximum).
  const todayKey = localDateKey(now, TZ);
  const days = useMemo(() => bookableDays((network?.booking_locations ?? []).map((b) => b.data), now, TZ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network, todayKey]);
  const soonDays = days.slice(0, MIN_BOOKING_DAYS);
  const laterDays = days.slice(MIN_BOOKING_DAYS);
  const dayKey = localDateKey(day, TZ);
  const pickDay = (d: Date) => { setDay(d); setSelectedKey(null); setResultId(null); };

  const selectSite = (s: Site) => {
    setSelectedKey(s.key);
    const o = s.best ?? s.options.find((x) => x.assessment.ok) ?? s.options[0];
    setOptionId(o?.bl.id ?? null);
    const l = o ? durationLimits(o.bl) : null;
    const dur = l ? Math.min(Math.max(duration, l.min), l.max) : duration;
    if (dur !== duration) setDuration(dur);
    setStart(o?.best?.start ?? null);
    setPower(o?.assessment.usableKw ? Math.round(o.assessment.usableKw) : null);
    setError(null);
    setResultId(null);
    setMobileView("list");
    requestAnimationFrame(() => {
      const top = (sideRef.current?.getBoundingClientRect().top ?? 0) + window.scrollY - 72;
      if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    });
  };

  // Keep the chosen start valid when duration/day/option change.
  useEffect(() => {
    if (!bl) return;
    if (start && checkSlot(bl, start, new Date(start.getTime() + duration * MINUTE), now).ok) return;
    const s = suggestSlots(bl, start ?? desired, duration, now, { count: 1, horizonMin: 14 * 60 })[0];
    setStart(s?.start ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bl?.id, duration]);

  const pickerDay = start ? startOfLocalDay(start, TZ) : day;
  const startOptions = useMemo(() => {
    if (!bl) return [] as Date[];
    const from = pickerDay.getTime();
    const out: Date[] = [];
    for (const w of availableWindows(bl, new Date(Math.max(from, now.getTime())), new Date(from + 30 * 60 * MINUTE))) {
      for (let t = ceilToStep(new Date(Math.max(w.start.getTime(), now.getTime())), w.increment, w.anchor).getTime(); t + duration * MINUTE <= w.end.getTime(); t += w.increment * MINUTE) {
        out.push(new Date(t));
        if (out.length > 160) break;
      }
    }
    return out;
  }, [bl, pickerDay, duration, now]);

  const end = start ? new Date(start.getTime() + duration * MINUTE) : null;
  const check = bl && start && end ? checkSlot(bl, start, end, now) : null;
  const terms = bl?.booking_terms ?? null;
  const dl = start && end ? deadlines(terms, start, end) : null;
  const cost = option && start ? estimateCost(option.tariff, duration, power ?? option.assessment.usableKw, vehicle?.battery_kwh) : null;
  const result = resultId ? bookings.find((b) => b.id === resultId) ?? null : null;

  const submit = async () => {
    if (!vehicle || !bl || !start || !end || !fleetId) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await api<BookingRow>("POST", `/fleets/${fleetId}/bookings`, {
        vehicle_id: vehicle.id, driver_id: driverId || null, cpo_country_code: bl.country_code, cpo_party_id: bl.party_id,
        booking_location_id: bl.id, start_at: start.toISOString(), end_at: end.toISOString(), power_required_kw: power, notes: notes || null,
      });
      upsertBooking(row);
      setResultId(row.id);
      if (row.reservation_status === "FAILED") setError("The operator didn't accept the request. Try another time or site.");
    } catch (e) {
      const msg = e instanceof ApiFailure ? e.message : "Couldn't send the booking request";
      setError(msg);
      toast(msg, "bad");
      void refreshNetwork().catch(() => undefined);
    } finally {
      setSubmitting(false);
    }
  };

  const pins: MapPin[] = sites.map((s) => ({
    key: s.key, lat: s.lat, lon: s.lon, label: s.shortName,
    state: s.key === selectedKey ? "sel" : s.fits && (!zeroTouchOnly || s.zeroTouch) && s.best?.best ? "fit" : "unfit",
  }));

  if (loaded.fleet && active.length === 0) {
    return (
      <div className="page">
        <div className="page-head"><h1>Book a slot</h1></div>
        <div className="panel"><Empty art={<TruckArt label="" />} title="Add a vehicle first" action={<a className="btn primary" href={href("/fleet", { add: 1 })}>Add vehicle</a>}>Sites are matched to each truck's size, connectors and how it starts charging.</Empty></div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Book a slot</h1>
          <div className="sub">Pick the truck and roughly when it needs charge. Sites are matched to it automatically.</div>
        </div>
        <div className="actions mobile-only">
          <Seg<"list" | "map"> label="View" value={mobileView} onChange={setMobileView} options={[{ value: "list", label: "List" }, { value: "map", label: "Map" }]} />
        </div>
      </div>

      <div className={`planner ${mobileView}-mode`}>
        <div className="planner-side" ref={sideRef}>
          {!site && <section className="panel criteria" aria-label="What to book">
            <VehiclePicker vehicles={active} value={vehicle} onChange={(v) => { setVehicleId(v.id); setSelectedKey(null); setResultId(null); }} />
            <div className="field">
              <span className="label">Day</span>
              <div className="chips" role="group" aria-label="Day">
                {soonDays.map((d) => (
                  <button key={d.toISOString()} type="button" className="chip" aria-pressed={localDateKey(d, TZ) === dayKey} onClick={() => pickDay(d)}>
                    {fmtDay(d, now)}
                  </button>
                ))}
              </div>
              {laterDays.length > 0 && (
                <select className="select later-day" aria-label="A later day" value={laterDays.some((d) => localDateKey(d, TZ) === dayKey) ? dayKey : ""}
                  onChange={(e) => { const d = laterDays.find((x) => localDateKey(x, TZ) === e.target.value); if (d) pickDay(d); }}>
                  <option value="">Later, up to {fmtDay(laterDays[laterDays.length - 1], now)}</option>
                  {laterDays.map((d) => <option key={d.toISOString()} value={localDateKey(d, TZ)}>{fmtDay(d, now)}</option>)}
                </select>
              )}
            </div>
            <div className="two">
              <div className="field">
                <label htmlFor="arrive">Arrives around</label>
                <select id="arrive" className="select" value={arrive} onChange={(e) => { setArrive(e.target.value); setSelectedKey(null); setResultId(null); }}>
                  {Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, "0")}:${String((i % 4) * 15).padStart(2, "0")}`).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="near">Near</label>
                <select id="near" className="select" value={nearName} onChange={(e) => setNearName(e.target.value)}>
                  <option value="">Anywhere</option>
                  {[...CITIES].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
              </div>
            </div>
            <div className="field">
              <span className="label">Charge for</span>
              <Seg label="Charge for" value={String(duration)} onChange={(v) => setDuration(Number(v))} options={[30, 45, 60, 90, 120, 180].map((d) => ({ value: String(d), label: fmtDuration(d).replace(" min", "m").replace(" h", "h") }))} />
            </div>
            <Switch checked={zeroTouchOnly} onChange={setZeroTouchOnly}>
              <span>Driver just turns up</span>
              <span className="hint" style={{ display: "block" }}>Only sites that open for the number plate and start charging automatically ({vehicle ? START_METHOD_LABEL[vehicle.start_method] : "Autocharge or Plug & Charge"}).</span>
            </Switch>
          </section>}

          {site && bl && vehicle ? (
            <SitePanel
              site={site} option={option!} vehicle={vehicle} onBack={() => { setSelectedKey(null); setResultId(null); }}
              onOption={(id) => { setOptionId(id); setResultId(null); }}
              start={start} setStart={(d) => { setStart(d); setResultId(null); }} duration={duration} setDuration={setDuration} lim={lim!}
              startOptions={startOptions} pickerDay={pickerDay} now={now} check={check} dl={dl} cost={cost}
              power={power} setPower={setPower} drivers={drivers} driverId={driverId} setDriverId={setDriverId}
              notes={notes} setNotes={setNotes} submitting={submitting} submit={submit} error={error} result={result}
              desired={desired}
            />
          ) : (
            <section className="panel results" aria-label="Matching sites">
              <div className="panel-head">
                <h2>{network ? (shown.length ? `${shown.length} ${shown.length === 1 ? "site fits" : "sites fit"} ${vehicle?.plate ?? ""}` : "No matching sites") : "Loading sites"}</h2>
                {network && <span className="right xs muted">{fmtDay(desired, now)} around {fmtTime(desired, TZ)}</span>}
              </div>
              {!network ? (
                <div className="empty"><Spinner /></div>
              ) : shown.length === 0 && needsAction.length === 0 ? (
                <Empty icon="search" title="Nothing fits this truck right now">
                  {network.booking_locations.length === 0 ? "No operators are connected yet. An admin can connect one in Network." : "Try another day, a shorter charge, or turn off “Driver just turns up”."}
                </Empty>
              ) : (
                <ul className="list">
                  {shown.map((s) => <ResultItem key={s.key} site={s} desired={desired} now={now} onSelect={() => selectSite(s)} />)}
                </ul>
              )}
              {needsAction.length > 0 && (
                <details className="disclose" style={{ padding: "4px 16px 10px", borderTop: "1px solid var(--line)" }}>
                  <summary><Icon name="chevronRight" size="sm" />{needsAction.length} more {needsAction.length === 1 ? "site needs" : "sites need"} the driver to do something</summary>
                  <ul className="list">
                    {needsAction.map((s) => <ResultItem key={s.key} site={s} desired={desired} now={now} onSelect={() => selectSite(s)} />)}
                  </ul>
                </details>
              )}
              {unfit.length > 0 && (
                <div style={{ padding: "4px 16px 12px", borderTop: "1px solid var(--line)" }}>
                  <button className="btn ghost sm" onClick={() => setShowUnfit(!showUnfit)} aria-expanded={showUnfit}>
                    <Icon name={showUnfit ? "chevronDown" : "chevronRight"} size="sm" />{unfit.length} {unfit.length === 1 ? "site can't" : "sites can't"} take {vehicle?.plate}
                  </button>
                  {showUnfit && (
                    <ul className="list" style={{ marginTop: 6 }}>
                      {unfit.map((s) => (
                        <li key={s.key} className="result unfit">
                          <div className="row gap-12"><span className="op-mark">{initials(s.operator)}</span><div><div className="title">{s.shortName}</div><div className="xs muted">{s.road ?? s.location.city}</div></div></div>
                          <div className="meta">{[...new Set(s.options.flatMap((o) => o.assessment.issues.filter((i) => i.level === "block").map((i) => i.text)))].slice(0, 2).map((t) => <span key={t} className="tag bad">{t}</span>)}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
        <div className="planner-map">
          <NetworkMap pins={pins} near={near} onSelect={(k) => { const s = sites.find((x) => x.key === k); if (s) selectSite(s); }} focusKey={selectedKey} />
        </div>
      </div>
    </div>
  );
}

/** "MCS 1 MW lanes" vs "CCS2 400 kW bays"; the connector is left out when every bay type shares it. */
function bayTypeLabel(o: SiteOption, all: SiteOption[]): string {
  const bo = o.bl.booking_option ?? {};
  const connOf = (x: SiteOption) => x.assessment.connector ?? x.bl.booking_option?.connector_types?.[0] ?? null;
  const conn = new Set(all.map(connOf)).size > 1 ? connOf(o) : null;
  const c = connOf(o);
  const kw = c ? o.assessment.spec.kwByType[c] ?? o.assessment.spec.maxKw : o.assessment.spec.maxKw;
  const types = bo.vehicle_types ?? [];
  const smallOnly = types.length > 0 && !types.some((t) => t === "SEMI_TRACTOR" || t === "TRUCK_WITH_TRAILER");
  const what = bo.drive_through ? "lanes" : smallOnly ? "rigid bays" : "bays";
  return [conn ? connectorLabel(conn) : null, kw ? fmtKw(kw) : null, what].filter(Boolean).join(" ");
}

function VehiclePicker({ vehicles, value, onChange }: { vehicles: Vehicle[]; value: Vehicle | null; onChange(v: Vehicle): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="field" ref={ref} style={{ position: "relative" }}>
      <span className="label" id="vehicle-label">Vehicle</span>
      <button type="button" className="vehicle-pick" aria-haspopup="listbox" aria-expanded={open} aria-labelledby="vehicle-label" onClick={() => setOpen(!open)}>
        {value ? <VehicleLine v={value} /> : <span className="muted">Choose a vehicle</span>}
        <Icon name="chevronDown" size="sm" className="right" />
      </button>
      {open && (
        <div className="vehicle-menu" role="listbox" aria-labelledby="vehicle-label">
          {vehicles.map((v) => (
            <button key={v.id} type="button" role="option" aria-selected={v.id === value?.id} onClick={() => { onChange(v); setOpen(false); }}>
              <VehicleLine v={v} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VehicleLine({ v }: { v: Vehicle }) {
  return (
    <span className="row gap-12 grow" style={{ minWidth: 0 }}>
      <Plate plate={v.plate} />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="ellipsis" style={{ display: "block", fontWeight: 560 }}>{v.name}</span>
        <span className="xs muted ellipsis" style={{ display: "block" }}>{VEHICLE_TYPE_LABEL[v.vehicle_type]}, {v.connector_types.map(connectorLabel).join(" + ")}, {START_METHOD_LABEL[v.start_method]}</span>
      </span>
    </span>
  );
}

function ResultItem({ site, desired, now, onSelect }: { site: Site; desired: Date; now: Date; onSelect(): void }) {
  const o = site.best;
  const s = o?.best ?? null;
  const spec = o?.assessment.spec;
  const kw = o?.assessment.connector ? spec?.kwByType[o.assessment.connector] ?? spec?.maxKw : spec?.maxKw;
  const delta = s ? s.deltaMin : null;
  const from = desired.getTime() - 12 * 3_600_000;
  const span = 24 * 3_600_000;
  const windows = o ? availableWindows(o.bl, new Date(Math.max(from, now.getTime())), new Date(from + span)) : [];
  const fee = o?.tariff ? (o.tariff.bookingFlat ?? 0) + (o.tariff.bookingPerHour ?? 0) * ((s ? (s.end.getTime() - s.start.getTime()) : 45 * MINUTE) / 3_600_000) : null;
  return (
    <li className="result" role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }} aria-label={`${site.shortName}, ${s ? fmtRange(s.start, s.end) : "no slot nearby"}`}>
      <div className="row gap-12" style={{ minWidth: 0 }}>
        <span className="op-mark" title={site.operator}>{initials(site.operator)}</span>
        <div style={{ minWidth: 0 }}>
          <div className="title ellipsis">{site.shortName}</div>
          <div className="xs muted ellipsis">{[site.road, site.location.city, site.distanceKm != null ? fmtMiles(site.distanceKm) : null].filter(Boolean).join(", ")}</div>
        </div>
      </div>
      <div className="when">
        {s ? (
          <>
            <div className="time">{fmtTime(s.start)}</div>
            <div className="xs muted">{delta === 0 ? "as asked" : `${Math.abs(delta!) >= 60 ? fmtDuration(Math.abs(delta!)) : `${Math.abs(delta!)} min`} ${delta! > 0 ? "later" : "earlier"}`}</div>
          </>
        ) : <div className="xs muted">No slot nearby</div>}
      </div>
      <div className="strip" aria-hidden="true">
        {windows.map((w, i) => <span key={i} style={{ left: `${((w.start.getTime() - from) / span) * 100}%`, width: `${((w.end.getTime() - w.start.getTime()) / span) * 100}%` }} />)}
        <i className="want" style={{ left: "50%" }} />
      </div>
      <div className="meta">
        {o?.assessment.connector && <span className="tag"><Icon name="zap" />{connectorLabel(o.assessment.connector)} {fmtKw(kw ?? null)}</span>}
        {o?.bl.booking_option?.drive_through && <span className="tag">Drive-through</span>}
        {o?.bl.booking_option?.refrigeration_outlet && <span className="tag"><Icon name="snowflake" />Reefer power</span>}
        {s?.window.green && <span className="tag ok"><Icon name="leaf" />Green energy</span>}
        {fee != null && <span className="tag">{fmtMoney(fee, o?.tariff?.currency)} booking</span>}
        {o && o.assessment.issues.filter((i) => i.level !== "block").map((i) => <span key={i.code} className={`tag ${i.level === "touch" ? "warn" : ""}`}>{i.text}</span>)}
        {site.isSimulator && <span className="tag">Simulated</span>}
      </div>
    </li>
  );
}

function SitePanel(props: {
  site: Site; option: SiteOption; vehicle: Vehicle; onBack(): void; onOption(id: string): void;
  start: Date | null; setStart(d: Date): void; duration: number; setDuration(n: number): void; lim: { min: number; max: number; step: number };
  startOptions: Date[]; pickerDay: Date; now: Date; check: ReturnType<typeof checkSlot> | null; dl: ReturnType<typeof deadlines> | null;
  cost: ReturnType<typeof estimateCost> | null; power: number | null; setPower(n: number): void;
  drivers: { id: string; name: string }[]; driverId: string; setDriverId(s: string): void; notes: string; setNotes(s: string): void;
  submitting: boolean; submit(): void; error: string | null; result: BookingRow | null; desired: Date;
}) {
  const { site, option, vehicle, start, duration, now, dl, cost, result } = props;
  const bl: BookingLocation = option.bl;
  const end = start ? new Date(start.getTime() + duration * MINUTE) : null;
  const opt = bl.booking_option ?? {};
  const spec = option.assessment.spec;
  const kw = option.assessment.connector ? spec.kwByType[option.assessment.connector] ?? spec.maxKw : spec.maxKw;
  const window = start ? availableWindows(bl, start, new Date(start.getTime() + MINUTE))[0] : undefined;
  const maxKw = Math.round(Math.min(option.assessment.usableKw ?? kw ?? 400, window?.maxPowerW ? window.maxPowerW / 1000 : Infinity));
  const minKw = Math.max(20, Math.round((window?.minPowerW ?? 0) / 1000 / 2));
  const suggestions = suggestSlots(bl, props.desired, duration, now, { count: 3, horizonMin: 8 * 60 });
  const durations = DURATIONS.filter((d) => d >= props.lim.min && d <= props.lim.max);
  const t = bl.booking_terms;
  const tariff = option.tariff;

  if (result) return <BookingResult result={result} site={site} vehicle={vehicle} onBack={props.onBack} now={now} />;

  return (
    <section className="panel" aria-label={site.shortName}>
      <div className="panel-head">
        <button className="btn ghost sm" onClick={props.onBack}><Icon name="chevronLeft" size="sm" />All sites</button>
        <span className="right row gap-8">
          {site.isSimulator && <span className="tag hide-xs">Simulated operator</span>}
          <Plate plate={vehicle.plate} size="sm" />
        </span>
      </div>
      <div className="site-head">
        <span className="op-mark">{initials(site.operator)}</span>
        <div className="grow">
          <h2 style={{ fontSize: "var(--fs-xl)" }}>{site.shortName}</h2>
          <div className="small muted">{site.operator}, {site.location.address}, {site.location.city} {site.location.postal_code ?? ""}</div>
        </div>
      </div>
      <div style={{ padding: "0 16px 16px" }} className="stack gap-16">
        {site.options.length > 1 && (
          <Seg label="Bay type" full value={bl.id} onChange={props.onOption} options={site.options.map((o) => ({
            value: o.bl.id,
            label: o.assessment.ok
              ? bayTypeLabel(o, site.options)
              : <span className="row gap-4" title={o.assessment.issues.find((i) => i.level === "block")?.text} style={{ color: "var(--muted)" }}><Icon name="circleX" size="sm" />{bayTypeLabel(o, site.options)}</span>,
          }))} />
        )}
        <div className="facts">
          <div className="fact"><Icon name="zap" /><span><b>{option.assessment.connector ? connectorLabel(option.assessment.connector) : "No match"} up to {fmtKw(kw)}</b>{option.assessment.usableKw && kw && option.assessment.usableKw < kw ? `${fmtKw(option.assessment.usableKw)} for this truck` : "DC"}</span></div>
          <div className="fact"><Icon name="scan" /><span><b>{spec.plateAccess ? "Plate recognition" : "Driver action at entry"}</b>{(t?.supported_access_methods ?? []).map((m) => ACCESS_LABEL[m]).join(", ")}</span></div>
          <div className="fact"><Icon name="plug" /><span><b>{spec.autoStart.length ? spec.autoStart.map((m) => START_METHOD_LABEL[m]).join(" + ") : "Manual start"}</b>{spec.autoStart.includes(vehicle.start_method) ? "Starts automatically" : "Doesn't auto-start this truck"}</span></div>
          <div className="fact"><Icon name="ruler" /><span><b>Bays up to {opt.max_vehicle_length ? `${opt.max_vehicle_length / 100} m` : "—"}</b>{opt.max_vehicle_weight ? `${Math.round(opt.max_vehicle_weight / 1000)} t` : ""}{opt.max_vehicle_height ? `, ${opt.max_vehicle_height / 100} m high` : ""}</span></div>
          {opt.drive_through && <div className="fact"><Icon name="route" /><span><b>Drive-through</b>No reversing</span></div>}
          {opt.refrigeration_outlet && <div className="fact"><Icon name="snowflake" /><span><b>Reefer power</b>Keep the trailer cold</span></div>}
          {opt.dangerous_goods_allowed && <div className="fact"><Icon name="flame" /><span><b>ADR loads allowed</b>Dangerous goods</span></div>}
        </div>
        {option.assessment.issues.length > 0 && (
          <div className="stack gap-6">
            {option.assessment.issues.map((i) => <div key={i.code} className={`tag ${i.level === "block" ? "bad" : i.level === "touch" ? "warn" : ""}`} style={{ height: "auto", padding: "5px 8px" }}><Icon name="info" />{i.text}</div>)}
          </div>
        )}

        <div className="divider" style={{ margin: 0 }} />
        <div className="stack gap-8">
          <h3>When</h3>
          <SlotPicker bl={bl} dayStart={props.pickerDay} now={now} start={start} duration={duration} onChange={props.setStart} tz={TZ} />
          <div className="legend"><span><i className="free" />Free</span><span><i className="busy" />Unavailable</span><span><i className="sel" />Your slot</span><span><i className="green" />Green energy</span></div>
        </div>

        <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="start">Start</label>
            <select id="start" className="select" value={start?.toISOString() ?? ""} onChange={(e) => props.setStart(new Date(e.target.value))}>
              {!start && <option value="">No free slot</option>}
              {start && !props.startOptions.some((d) => d.getTime() === start.getTime()) && <option value={start.toISOString()}>{fmtTime(start)} (unavailable)</option>}
              {props.startOptions.map((d) => <option key={d.toISOString()} value={d.toISOString()}>{fmtDay(d, now) === fmtDay(props.pickerDay, now) ? "" : `${fmtDay(d, now)} `}{fmtTime(d)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dur">Charge for</label>
            <select id="dur" className="select" value={duration} onChange={(e) => props.setDuration(Number(e.target.value))}>
              {durations.map((d) => <option key={d} value={d}>{fmtDuration(d)}</option>)}
            </select>
          </div>
        </div>
        {suggestions.length > 0 && (
          <div className="chips" aria-label="Suggested times">
            {suggestions.map((s) => (
              <button key={s.start.toISOString()} type="button" className="chip" aria-pressed={start?.getTime() === s.start.getTime()} onClick={() => props.setStart(s.start)}>
                {fmtTime(s.start)}<span className="sub">{s.deltaMin === 0 ? "as asked" : `${s.deltaMin > 0 ? "+" : "−"}${fmtDuration(Math.abs(s.deltaMin))}`}</span>
              </button>
            ))}
          </div>
        )}
        {props.check && !props.check.ok && <div className="error-text">{props.check.reason}</div>}

        {maxKw > minKw && (
          <div className="field">
            <label htmlFor="power">Power requested: {fmtKw(props.power ?? maxKw)}</label>
            <input id="power" className="range" type="range" min={minKw} max={maxKw} step={10} value={Math.min(props.power ?? maxKw, maxKw)} onChange={(e) => props.setPower(Number(e.target.value))} />
            <span className="hint">Asking for less than the maximum can make it easier for the operator to fit you in.</span>
          </div>
        )}

        <div className="two" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div className="field">
            <label htmlFor="driver">Driver</label>
            <select id="driver" className="select" value={props.driverId} onChange={(e) => props.setDriverId(e.target.value)}>
              <option value="">Not assigned yet</option>
              {props.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="notes">Note for your team</label>
            <input id="notes" className="input" value={props.notes} onChange={(e) => props.setNotes(e.target.value)} placeholder="Optional" />
          </div>
        </div>

        {dl && (
          <dl className="kv">
            <dt>Arrive</dt><dd>From {fmtTime(dl.arriveFrom)}{dl.noShowAt ? `. Released at ${fmtTime(dl.noShowAt)} if the truck hasn't arrived` : ""}</dd>
            <dt>Free cancellation</dt><dd>Until {fmtDateTime(dl.cancelFreeUntil, now)}{tariff?.cancelFee ? `, then ${fmtMoney(tariff.cancelFee, tariff.currency)}` : ""}</dd>
            <dt>Changes</dt><dd>{dl.changeUntil ? `Until ${fmtDateTime(dl.changeUntil, now)}` : "Not allowed"}</dd>
            {tariff && <><dt>Prices</dt><dd>{tariff.energyPerKwh != null ? `${fmtMoney(tariff.energyPerKwh, tariff.currency)} per kWh` : ""}{tariff.noShowFee ? `, no-show ${fmtMoney(tariff.noShowFee, tariff.currency)}` : ""}{tariff.overtimePerHour ? `, overstay ${fmtMoney(tariff.overtimePerHour / 60, tariff.currency)} per min` : ""}{tariff.taxIncluded === "NO" ? ", plus VAT" : ""}</dd></>}
            {t?.booking_terms && <><dt>Terms</dt><dd><a href={t.booking_terms} target="_blank" rel="noreferrer">Operator booking terms</a></dd></>}
          </dl>
        )}
        {props.error && <div className="error-text" role="alert">{props.error}</div>}
      </div>
      <div className="summary-bar">
        <div className="grow">
          {start && end ? (
            <>
              <div style={{ fontWeight: 650 }} className="num">{fmtDay(start, now)}, {fmtRange(start, end)}</div>
              <div className="xs muted">{cost ? `${fmtMoney(cost.booking, tariff?.currency)} booking${cost.total != null ? `, about ${fmtMoney(cost.total, tariff?.currency)} with ${cost.kwh} kWh` : ""}` : ""}</div>
            </>
          ) : <span className="muted small">Choose a time</span>}
        </div>
        <button className="btn primary lg" disabled={!props.check?.ok || props.submitting || !option.assessment.ok} onClick={props.submit}>
          {props.submitting ? <Spinner label="Sending" /> : null}Request booking
        </button>
      </div>
    </section>
  );
}

function BookingResult({ result, site, vehicle, onBack, now }: { result: BookingRow; site: Site; vehicle: Vehicle; onBack(): void; now: Date }) {
  const s = result.reservation_status;
  const decided = s !== "PENDING";
  const ok = s === "RESERVED" || s === "FULFILLED";
  return (
    <section className="panel" aria-live="polite">
      <div className="panel-head">
        <button className="btn ghost sm" onClick={onBack}><Icon name="chevronLeft" size="sm" />All sites</button>
        <span className="right"><StatusBadge booking={result} /></span>
      </div>
      <div className="panel-body stack gap-16">
        <div className="row gap-12">
          <Plate plate={vehicle.plate} />
          <div className="grow">
            <div style={{ fontWeight: 620 }}>{site.shortName}</div>
            <div className="small muted num">{fmtDay(result.start_at, now)}, {fmtRange(result.start_at, result.end_at)}</div>
          </div>
        </div>
        <div className="progress">
          <div className="step done"><span className="dot"><Icon name="check" size="sm" /></span><div><b>Request sent to {site.operator}</b><div className="xs muted">OCPI BookingRequest, reference {result.authorization_reference}</div></div></div>
          <div className={`step ${decided ? (ok ? "done" : "fail") : "live"}`}>
            <span className="dot">{decided ? <Icon name={ok ? "check" : "x"} size="sm" /> : null}</span>
            <div>
              <b>{!decided ? "Waiting for the operator to confirm" : ok ? "Bay reserved" : s === "REJECTED" ? "Not accepted" : "Booking failed"}</b>
              <div className="xs muted">{!decided ? "This usually takes a few seconds." : ok ? "The plate is on the site's list and the charger will recognise the truck." : "The slot has gone. Pick another time or site."}</div>
            </div>
          </div>
        </div>
        {ok && <PassShare booking={result} vehicle={vehicle} siteName={site.shortName} />}
        {ok && (
          <div className="stack gap-8">
            <b>What happens on site</b>
            <ChargeStory
              audience="planner"
              truck={truckKindOf(vehicle.vehicle_type)}
              access={accessKindOf(result.booking?.booking_terms?.supported_access_methods)}
              start={vehicle.start_method}
              plate={vehicle.plate}
              maxKw={result.power_required_kw ?? 350}
            />
          </div>
        )}
        <div className="row gap-8 wrap">
          {ok && <a className="btn" href={href("/bookings", { open: result.id })}>View booking</a>}
          <button className="btn ghost" onClick={onBack}>{ok ? "Book another" : "Choose another slot"}</button>
        </div>
      </div>
    </section>
  );
}

export { navigate };
