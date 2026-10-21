import { useEffect, useState } from "react";
import type { ConnectorType, VehicleType } from "../../shared/ocpi/types";
import type { Driver, StartMethod, Vehicle } from "../../shared/model";
import { START_METHOD_LABEL, VEHICLE_TYPE_LABEL, connectorLabel } from "../../shared/booking/labels";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtKw, fmtMetres, fmtTonnes } from "../app/format";
import { navigate, useRoute } from "../app/router";
import { Avatar, Empty, Field, Icon, Modal, Plate, Seg, Spinner, Switch } from "../ui/ui";
import { TruckArt } from "../components/art/Mini";
import { truckKindOf } from "../components/art/scene";

const PRESETS: { type: VehicleType; label: string; sub: string; weight: number; height: number; length: number; width: number }[] = [
  { type: "TRUCK_WITH_TRAILER", label: "Tractor + trailer", sub: "44 t, 16.5 m", weight: 44000, height: 400, length: 1650, width: 255 },
  { type: "SEMI_TRACTOR", label: "Tractor unit", sub: "Bobtail, 6.5 m", weight: 18000, height: 380, length: 650, width: 255 },
  { type: "RIGID", label: "Rigid", sub: "19–32 t, 10 m", weight: 19000, height: 360, length: 1000, width: 255 },
  { type: "VAN", label: "Van", sub: "Up to 4.25 t", weight: 4250, height: 270, length: 700, width: 220 },
  { type: "BUS", label: "Bus or coach", sub: "12–15 m", weight: 19500, height: 380, length: 1300, width: 255 },
];
const CONNECTORS: ConnectorType[] = ["MCS", "IEC_62196_T2_COMBO", "IEC_62196_T2"];

export function FleetPage() {
  const { vehicles, drivers, loaded, me, fleetId } = useApp();
  const route = useRoute();
  const [tab, setTab] = useState<"vehicles" | "drivers">(route.params.get("tab") === "drivers" ? "drivers" : "vehicles");
  const [editing, setEditing] = useState<Vehicle | "new" | null>(route.params.get("add") ? "new" : null);
  const [editingDriver, setEditingDriver] = useState<Driver | "new" | null>(null);
  const role = me?.memberships.find((m) => m.fleet_id === fleetId)?.role;
  const canWrite = role !== "viewer";

  useEffect(() => {
    if (route.params.get("add")) navigate("/fleet", {}, { replace: true });
  }, [route.params]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Fleet</h1>
          <div className="sub">Each truck's plate opens site gates; its charging ID starts the charger. Dimensions decide which bays fit.</div>
        </div>
        <div className="actions">
          {canWrite && (tab === "vehicles"
            ? <button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" size="sm" />Add vehicle</button>
            : <button className="btn primary" onClick={() => setEditingDriver("new")}><Icon name="plus" size="sm" />Add driver</button>)}
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <Seg<"vehicles" | "drivers"> label="Show" value={tab} onChange={setTab} options={[{ value: "vehicles", label: `Vehicles (${vehicles.length})` }, { value: "drivers", label: `Drivers (${drivers.length})` }]} />
      </div>

      {tab === "vehicles" ? (
        !loaded.fleet ? <div className="panel" style={{ padding: 16 }}><div className="skeleton" style={{ height: 48 }} /></div>
          : vehicles.length === 0 ? (
            <div className="panel"><Empty art={<TruckArt label="" />} title="No vehicles yet" action={canWrite ? <button className="btn primary" onClick={() => setEditing("new")}>Add vehicle</button> : undefined}>Add a truck with its plate, size and charging ID to start booking.</Empty></div>
          ) : (
            <ul className="list panel">
              {vehicles.map((v) => (
                <li key={v.id} className="vehicle-row" style={{ opacity: v.active ? 1 : 0.6 }}>
                  <Plate plate={v.plate} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }} className="ellipsis">{v.name}{!v.active && <span className="tag" style={{ marginLeft: 8 }}>Inactive</span>}</div>
                    <div className="xs muted ellipsis">{v.make_model ?? VEHICLE_TYPE_LABEL[v.vehicle_type]}</div>
                  </div>
                  <div className="small hide-sm">
                    <div>{VEHICLE_TYPE_LABEL[v.vehicle_type]}</div>
                    <div className="xs muted">{fmtTonnes(v.gross_weight_kg)}, {fmtMetres(v.length_cm)} long, {fmtMetres(v.height_cm)} high</div>
                  </div>
                  <div className="small hide-sm">
                    <div>{START_METHOD_LABEL[v.start_method]}</div>
                    <div className="xs muted">{v.connector_types.map(connectorLabel).join(" + ")}{v.max_charge_kw ? `, up to ${fmtKw(v.max_charge_kw)}` : ""}{v.needs_reefer_outlet ? ", reefer" : ""}{v.dangerous_goods ? ", ADR" : ""}</div>
                  </div>
                  {canWrite && <button className="btn sm ghost" onClick={() => setEditing(v)} aria-label={`Edit ${v.name}`}><Icon name="pencil" size="sm" />Edit</button>}
                </li>
              ))}
            </ul>
          )
      ) : drivers.length === 0 ? (
        <div className="panel"><Empty icon="users" title="No drivers yet" action={canWrite ? <button className="btn primary" onClick={() => setEditingDriver("new")}>Add driver</button> : undefined}>Drivers are optional. Assigning one keeps the pass and your team in sync.</Empty></div>
      ) : (
        <ul className="list panel">
          {drivers.map((d) => (
            <li key={d.id} className="row gap-12" style={{ padding: "12px 16px" }}>
              <Avatar name={d.name} />
              <div className="grow"><div style={{ fontWeight: 560 }}>{d.name}</div><div className="xs muted">{d.phone ?? "No phone number"}</div></div>
              {canWrite && <button className="btn sm ghost" onClick={() => setEditingDriver(d)}><Icon name="pencil" size="sm" />Edit</button>}
            </li>
          ))}
        </ul>
      )}

      {editing && <VehicleForm vehicle={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {editingDriver && <DriverForm driver={editingDriver === "new" ? null : editingDriver} onClose={() => setEditingDriver(null)} />}
    </div>
  );
}

function VehicleForm({ vehicle, onClose }: { vehicle: Vehicle | null; onClose(): void }) {
  const { api, fleetId, refreshFleet, toast } = useApp();
  const [v, setV] = useState<Partial<Vehicle>>(() => vehicle ?? {
    vehicle_type: "TRUCK_WITH_TRAILER", gross_weight_kg: 44000, height_cm: 400, length_cm: 1650, width_cm: 255,
    connector_types: ["IEC_62196_T2_COMBO", "MCS"], start_method: "PLUG_AND_CHARGE", active: true, max_charge_kw: 750,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof Vehicle>(k: K, val: Vehicle[K]) => setV((x) => ({ ...x, [k]: val }));
  const num = (s: string) => (s === "" ? null : Number(s));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (vehicle) await api("PUT", `/fleets/${fleetId}/vehicles/${vehicle.id}`, v);
      else await api("POST", `/fleets/${fleetId}/vehicles`, v);
      await refreshFleet();
      toast(vehicle ? "Vehicle saved" : "Vehicle added");
      onClose();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't save the vehicle");
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    setSaving(true);
    try {
      await api("DELETE", `/fleets/${fleetId}/vehicles/${vehicle!.id}`);
      await refreshFleet();
      toast("Vehicle removed");
      onClose();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't remove the vehicle");
      setSaving(false);
    }
  };

  const method = (v.start_method ?? "PLUG_AND_CHARGE") as StartMethod;
  return (
    <Modal title={vehicle ? `Edit ${vehicle.name}` : "Add vehicle"} onClose={onClose} foot={
      <>
        {vehicle && (confirmDelete
          ? <button className="btn danger" style={{ marginRight: "auto" }} onClick={remove} disabled={saving}>Remove {vehicle.plate}</button>
          : <button className="btn ghost" style={{ marginRight: "auto" }} onClick={() => setConfirmDelete(true)}><Icon name="trash" size="sm" />Remove</button>)}
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving}>{saving && <Spinner />}{vehicle ? "Save vehicle" : "Add vehicle"}</button>
      </>
    }>
      <div className="stack gap-16">
        <div className="vehicle-preview" aria-hidden="true">
          <TruckArt truck={truckKindOf(v.vehicle_type)} port={method === "AUTOCHARGE" ? "linked" : "charging"} label="" />
          <div className="vehicle-preview-tags">
            {v.plate ? <Plate plate={v.plate} size="sm" /> : null}
            <span className="tag brand">{method === "AUTOCHARGE" ? "Autocharge" : "Plug & Charge"}</span>
          </div>
        </div>
        <div className="field">
          <span className="label">Type</span>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button key={p.type} type="button" className="preset" aria-pressed={v.vehicle_type === p.type} onClick={() => setV((x) => ({ ...x, vehicle_type: p.type, ...(vehicle ? {} : { gross_weight_kg: p.weight, height_cm: p.height, length_cm: p.length, width_cm: p.width }) }))}>
                <b className="small">{p.label}</b><span className="xs muted">{p.sub}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="form-grid">
          <Field label="Number plate">{(id) => <input id={id} className="input" value={v.plate ?? ""} onChange={(e) => set("plate", e.target.value.toUpperCase())} placeholder="PN74 EVH" autoComplete="off" style={{ textTransform: "uppercase", fontWeight: 600 }} />}</Field>
          <Field label="Name">{(id) => <input id={id} className="input" value={v.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="Tractor 06" />}</Field>
          <Field label="Make and model">{(id) => <input id={id} className="input" value={v.make_model ?? ""} onChange={(e) => set("make_model", e.target.value)} placeholder="Optional" />}</Field>
          <Field label="Max charging power (kW)">{(id) => <input id={id} className="input" inputMode="numeric" value={v.max_charge_kw ?? ""} onChange={(e) => set("max_charge_kw", num(e.target.value))} />}</Field>
          <Field label="Gross weight (kg)">{(id) => <input id={id} className="input" inputMode="numeric" value={v.gross_weight_kg ?? ""} onChange={(e) => set("gross_weight_kg", num(e.target.value))} />}</Field>
          <Field label="Battery (kWh)">{(id) => <input id={id} className="input" inputMode="numeric" value={v.battery_kwh ?? ""} onChange={(e) => set("battery_kwh", num(e.target.value))} placeholder="Optional" />}</Field>
          <Field label="Length (cm)" hint="As it arrives, trailer included">{(id) => <input id={id} className="input" inputMode="numeric" value={v.length_cm ?? ""} onChange={(e) => set("length_cm", num(e.target.value))} />}</Field>
          <Field label="Height (cm)">{(id) => <input id={id} className="input" inputMode="numeric" value={v.height_cm ?? ""} onChange={(e) => set("height_cm", num(e.target.value))} />}</Field>
        </div>
        <div className="field">
          <span className="label">Charging inlets</span>
          <div className="chips">
            {CONNECTORS.map((c) => {
              const on = (v.connector_types ?? []).includes(c);
              return <button key={c} type="button" className="chip" aria-pressed={on} onClick={() => set("connector_types", on ? (v.connector_types ?? []).filter((x) => x !== c) : [...(v.connector_types ?? []), c])}>{connectorLabel(c)}</button>;
            })}
          </div>
        </div>
        <div className="field">
          <span className="label">How charging starts</span>
          <div className="choice-grid">
            {(["PLUG_AND_CHARGE", "AUTOCHARGE"] as StartMethod[]).map((m) => (
              <button key={m} type="button" className="choice" aria-pressed={method === m} onClick={() => set("start_method", m)}>
                <b>{START_METHOD_LABEL[m]}</b>
                <span className="xs muted">{m === "PLUG_AND_CHARGE" ? "ISO 15118 contract certificate in the vehicle. Sent to operators as an EMAID token." : "The charger reads the vehicle's ID (EVCCID). Sent to operators as an OTHER token."}</span>
              </button>
            ))}
          </div>
        </div>
        <Field label={method === "PLUG_AND_CHARGE" ? "Contract ID (EMAID)" : "Autocharge vehicle ID"} hint={method === "PLUG_AND_CHARGE" ? "From the contract certificate, for example GBDPCC00000101K" : "Usually VID: followed by the 12-character MAC address, for example VID:A4B2C3D4E5F6"}>
          {(id) => <input id={id} className="input" value={v.token_uid ?? ""} onChange={(e) => set("token_uid", e.target.value.toUpperCase())} autoComplete="off" style={{ fontFamily: "var(--mono)", fontSize: 13 }} />}
        </Field>
        <div className="stack gap-8">
          <label className="check"><input type="checkbox" checked={!!v.needs_reefer_outlet} onChange={(e) => set("needs_reefer_outlet", e.target.checked)} /><span>Needs reefer power for the trailer</span></label>
          <label className="check"><input type="checkbox" checked={!!v.dangerous_goods} onChange={(e) => set("dangerous_goods", e.target.checked)} /><span>Carries ADR (dangerous goods) loads</span></label>
          <Switch checked={v.active !== false} onChange={(x) => set("active", x)}>Available for bookings</Switch>
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
      </div>
    </Modal>
  );
}

function DriverForm({ driver, onClose }: { driver: Driver | null; onClose(): void }) {
  const { api, fleetId, refreshFleet, toast } = useApp();
  const [name, setName] = useState(driver?.name ?? "");
  const [phone, setPhone] = useState(driver?.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      if (driver) await api("PUT", `/fleets/${fleetId}/drivers/${driver.id}`, { name, phone });
      else await api("POST", `/fleets/${fleetId}/drivers`, { name, phone });
      await refreshFleet();
      toast(driver ? "Driver saved" : "Driver added");
      onClose();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't save");
      setSaving(false);
    }
  };
  const remove = async () => {
    await api("DELETE", `/fleets/${fleetId}/drivers/${driver!.id}`);
    await refreshFleet();
    toast("Driver removed");
    onClose();
  };
  return (
    <Modal title={driver ? `Edit ${driver.name}` : "Add driver"} onClose={onClose} foot={
      <>
        {driver && <button className="btn ghost" style={{ marginRight: "auto" }} onClick={remove}><Icon name="trash" size="sm" />Remove</button>}
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={save} disabled={saving || !name.trim()}>{driver ? "Save driver" : "Add driver"}</button>
      </>
    }>
      <div className="stack gap-16">
        <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
        <Field label="Mobile number" hint="Used for sending the pass by text">{(id) => <input id={id} className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07700 900123" />}</Field>
        {error && <div className="error-text">{error}</div>}
      </div>
    </Modal>
  );
}
