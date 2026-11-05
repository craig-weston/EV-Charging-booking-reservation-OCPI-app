// Settings → For developers → Battery levels from the trucks: connect the truck makers' rFMS API
// (Volvo Connect, MAN RIO and others), match each truck's VIN, or have any telematics system send
// readings to the API. See docs/telematics.md.
import { useCallback, useEffect, useState } from "react";
import type { EnergyState } from "../../shared/model";
import type { EnergyConfig } from "../../shared/energy/depot";
import { VIN, type RfmsSettings, type Telemetry, type TelematicsConfig } from "../../shared/energy/telematics";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtRelative } from "../app/format";
import { Field, Icon, Plate, Seg, Spinner } from "../ui/ui";
import { MoreRow } from "../components/More";

type EnergyView = { config: EnergyConfig; state: EnergyState; has_secret: Record<string, boolean> };
const EMPTY_RFMS: RfmsSettings = { base_url: "", auth: "basic", username: "", vins: {} };
const hostOf = (u?: string) => { try { return u ? new URL(u).host : ""; } catch { return ""; } };

export function TelematicsSettings() {
  const { api, fleetId, vehicles, toast, now } = useApp();
  const [energy, setEnergy] = useState<EnergyView | null>(null);
  const [draft, setDraft] = useState<TelematicsConfig>({ kind: "none" });
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [test, setTest] = useState<{ trucks: number; unmatched: string[] } | null>(null);
  const load = useCallback(async () => {
    if (!fleetId) return;
    const e = await api<EnergyView>("GET", `/fleets/${fleetId}/energy`);
    setEnergy(e);
    setDraft(e.config.telematics ?? { kind: "none" });
  }, [api, fleetId]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const tel: Record<string, Telemetry> = energy?.state.telemetry ?? {};
  const reporting: Telemetry[] = Object.values(tel).filter((t) => now.getTime() - Date.parse(t.at) < 3 * 3_600_000);
  const latest = reporting.map((t) => t.at).sort().pop();
  const saved = energy?.config.telematics ?? { kind: "none" };
  const summary = !energy ? "Loading…"
    : saved.kind === "none" ? (reporting.length ? `${reporting.length} trucks sending readings to the API` : "Not connected. Trucks or your telematics system can also send readings to the API.")
    : `${saved.kind === "rfms" ? "rFMS" : "Simulated"} · ${reporting.length ? `${reporting.length} ${reporting.length === 1 ? "truck" : "trucks"} reporting, latest ${fmtRelative(latest!, now)}` : "no readings yet"}`;
  const r: RfmsSettings | null = draft.kind === "rfms" ? draft.rfms ?? EMPTY_RFMS : null;
  const setR = (p: Partial<RfmsSettings>) => setDraft({ kind: "rfms", rfms: { ...(r ?? EMPTY_RFMS), ...p } });
  // The server drops the stored password when the address moves to another host.
  const savedR = saved.kind === "rfms" ? saved.rfms : undefined;
  const moved = !!r && !!savedR && (hostOf(r.base_url) !== hostOf(savedR.base_url) || hostOf(r.token_url) !== hostOf(savedR.token_url));
  const badVins: string[] = r ? Object.values(r.vins as Record<string, string>).filter((v) => v && !VIN.test(v)) : [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved) || !!secret;

  const save = async () => {
    if (!energy || !fleetId) return;
    setBusy("save");
    try {
      const vins: Record<string, string> = r ? Object.fromEntries(Object.entries(r.vins as Record<string, string>).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim().toUpperCase()])) : {};
      const telematics: TelematicsConfig = draft.kind === "rfms" ? { kind: "rfms", rfms: { ...(r ?? EMPTY_RFMS), vins } } : draft;
      const e = await api<EnergyView>("PUT", `/fleets/${fleetId}/energy`, { config: { ...energy.config, telematics }, secrets: secret ? { telematics: secret } : undefined });
      setEnergy(e); setDraft(e.config.telematics ?? { kind: "none" }); setSecret("");
      toast("Truck data settings saved");
    } catch (x) {
      toast(x instanceof ApiFailure ? x.message : "Couldn't save", "bad");
    } finally { setBusy(null); }
  };
  const runTest = async () => {
    if (!fleetId) return;
    setBusy("test"); setTest(null);
    try {
      const t = await api<{ trucks: number; unmatched: string[] }>("POST", `/fleets/${fleetId}/telematics/test`);
      setTest(t);
      await load();
    } catch (x) {
      toast(x instanceof ApiFailure ? x.message : "Couldn't reach the truck data service", "bad");
    } finally { setBusy(null); }
  };

  return (
    <MoreRow icon="wifi" title="Battery levels from the trucks" summary={summary} id="s-telematics">
      <div className="stack gap-12">
        <p className="small muted" style={{ margin: 0 }}>
          Electric trucks report their battery level and range. The depot plan uses a recent reading instead of the typed-in charge for trucks in the yard or
          about to arrive, and the dashboard shows it on each truck.
        </p>
        <Seg<"none" | "rfms" | "simulated"> label="Source" value={draft.kind}
          onChange={(k) => { setDraft(k === "rfms" ? { kind: "rfms", rfms: r ?? EMPTY_RFMS } : { kind: k }); setTest(null); }}
          options={[{ value: "none", label: "API only" }, { value: "rfms", label: "rFMS (Volvo, MAN, …)" }, ...(saved.kind === "simulated" ? [{ value: "simulated" as const, label: "Simulated" }] : [])]} />
        {r && (
          <div className="stack gap-12">
            <Field label="rFMS address" hint="From your truck maker's developer portal: the part before /vehiclestatuses.">
              {(id) => <input id={id} className="input" placeholder="https://api.truckmaker.example/rfms" value={r.base_url} onChange={(e) => setR({ base_url: e.target.value })} />}
            </Field>
            <Seg<"basic" | "oauth2"> label="Sign-in" value={r.auth} onChange={(a) => setR({ auth: a })} options={[{ value: "basic", label: "User name and password" }, { value: "oauth2", label: "OAuth2 client" }]} />
            <div className="form-grid">
              <Field label={r.auth === "oauth2" ? "Client ID" : "User name"}>{(id) => <input id={id} className="input" autoComplete="off" value={r.username} onChange={(e) => setR({ username: e.target.value })} />}</Field>
              <Field label={r.auth === "oauth2" ? "Client secret" : "Password"} hint={!energy?.has_secret.telematics ? "Stored encrypted; never shown again." : moved ? "New address: enter it again." : `Saved (ends ${r.secret_hint ?? "…"}). Type a new one to replace it.`}>
                {(id) => <input id={id} className="input" type="password" autoComplete="new-password" value={secret} onChange={(e) => setSecret(e.target.value)} />}
              </Field>
            </div>
            {r.auth === "oauth2" && (
              <Field label="Token address">{(id) => <input id={id} className="input" placeholder="https://auth.truckmaker.example/oauth2/token" value={r.token_url ?? ""} onChange={(e) => setR({ token_url: e.target.value })} />}</Field>
            )}
            <div>
              <div className="label" style={{ marginBottom: 6 }}>VIN for each truck</div>
              <ul className="list vin-list">
                {vehicles.filter((v) => v.active).map((v) => (
                  <li key={v.id} className="row gap-12">
                    <Plate plate={v.plate} size="sm" />
                    <span className="grow small ellipsis">{v.name}</span>
                    <input className="input" aria-label={`VIN for ${v.plate}`} placeholder="17 characters" value={r.vins[v.id] ?? ""}
                      onChange={(e) => setR({ vins: { ...r.vins, [v.id]: e.target.value.toUpperCase() } })} />
                  </li>
                ))}
              </ul>
              {badVins.length > 0 && <div className="error-text" role="alert">A VIN is 11–17 letters and numbers (no I, O or Q)</div>}
            </div>
          </div>
        )}
        <div className="row gap-8 wrap" style={{ alignItems: "center" }}>
          <button className="btn primary sm" disabled={!dirty || !!busy || badVins.length > 0} onClick={() => void save()}>{busy === "save" && <Spinner />}Save</button>
          {saved.kind === "rfms" && <button className="btn sm" disabled={!!busy || dirty} onClick={() => void runTest()}>{busy === "test" ? <Spinner /> : <Icon name="refresh" size="sm" />}Check now</button>}
          {test && <span className="small">{test.trucks} {test.trucks === 1 ? "truck" : "trucks"} reported{test.unmatched.length ? `. Not linked yet: ${test.unmatched.slice(0, 4).join(", ")}${test.unmatched.length > 4 ? "…" : ""}` : ""}</span>}
        </div>
        <p className="xs muted" style={{ margin: 0 }}>
          Any telematics system can also send readings: <code>POST /api/fleets/{fleetId ?? "…"}/telemetry</code> with an API key, matched by plate, VIN or vehicle id. See docs/telematics.md.
        </p>
      </div>
    </MoreRow>
  );
}
