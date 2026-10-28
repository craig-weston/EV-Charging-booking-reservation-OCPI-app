// The driver's pass: a phone-first page opened from a text or WhatsApp link. No login.
import { useEffect, useState } from "react";
import type { PassView } from "../../shared/model";
import { START_METHOD_LABEL, statusView } from "../../shared/booking/labels";
import { deadlines } from "../../shared/booking/terms";
import type { Backend } from "../app/backend";
import { ApiFailure } from "../app/backend";
import { applyBrand } from "../app/brand";
import { fmtDay, fmtKwh, fmtRange, fmtTime, sessionKw } from "../app/format";
import { BrandMark, Empty, Icon, Plate, Spinner } from "../ui/ui";
import { ChargeStory } from "../components/art/ChargeStory";
import { ChargingMini } from "../components/art/Mini";
import { accessKindOf, truckKindOf } from "../components/art/scene";

export function PassPage({ backend, token }: { backend: Backend; token: string }) {
  const [pass, setPass] = useState<PassView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => backend.api<PassView>("GET", `/pass/${encodeURIComponent(token)}`)
      .then((p) => { if (alive) { setPass(p); setError(null); } })
      .catch((e) => { if (alive) setError(e instanceof ApiFailure ? e.message : "Couldn't load this pass"); });
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [backend, token]);

  useEffect(() => {
    if (pass) {
      applyBrand(pass.brand);
      document.title = `${pass.plate} at ${pass.site.name}`;
    }
  }, [pass]);

  if (error) return <div className="pass"><div className="pass-card"><Empty icon="alert" title="Pass not available">{error}</Empty></div></div>;
  if (!pass) return <div className="pass" style={{ alignItems: "center", paddingTop: 80 }}><Spinner /></div>;

  const now = new Date();
  const tz = pass.site.time_zone;
  const dl = deadlines(pass.terms, pass.start_at, pass.end_at);
  const v = statusView(pass.status, { sessionStatus: pass.session?.status, pending: !!pass.pending_action });
  const live = pass.status === "RESERVED" || pass.status === "PENDING" || pass.status === "FULFILLED";
  const maps = `https://www.google.com/maps/dir/?api=1&destination=${pass.site.lat},${pass.site.lon}`;
  const plateEntry = pass.access_methods.includes("LICENSE_PLATE") || pass.access_methods.includes("OPEN");

  return (
    <div className="pass">
      <div className="pass-head">
        <BrandMark brand={pass.brand} />
        <span className={`status ${v.tone} right`}>{v.label}</span>
      </div>

      <div className="pass-card">
        <div className="pass-hero">
          <div className="row gap-12 wrap">
            <Plate plate={pass.plate} size="lg" />
          </div>
          <div>
            <div className="small muted">{fmtDay(pass.start_at, now, tz)}</div>
            <div className="pass-time">{fmtRange(pass.start_at, pass.end_at, tz)}</div>
          </div>
          <div>
            <div style={{ fontWeight: 650, fontSize: "var(--fs-lg)" }}>{pass.site.name}</div>
            <div className="small muted">{pass.site.address}, {pass.site.city} {pass.site.postal_code ?? ""}</div>
          </div>
          {pass.session?.status === "ACTIVE" && (
            <div className="stack gap-8">
              <ChargingMini size="lg" truck={truckKindOf(pass.vehicle_type)} kw={sessionKw({ session: pass.session, power_required_kw: pass.power_kw }, now)} />
              <div className="tag ok" style={{ height: 32, fontSize: 14, alignSelf: "flex-start" }}><Icon name="battery" size="sm" />{pass.session.kwh >= 1 ? `Charging, ${fmtKwh(pass.session.kwh)} so far` : "Charging started"}</div>
            </div>
          )}
          <div className="row gap-8 wrap pass-actions">
            <a className="btn primary lg" href={maps} target="_blank" rel="noreferrer"><Icon name="navigation" size="sm" />Directions</a>
            {pass.site.help_phone && <a className="btn lg" href={`tel:${pass.site.help_phone}`}><Icon name="phone" size="sm" />Site help</a>}
          </div>
        </div>
        {live && (
          <ol className="pass-steps">
            <li>
              <div>
                <b>Arrive from {fmtTime(dl.arriveFrom, tz)}</b>
                <div className="small muted">{dl.noShowAt ? `The bay is held until ${fmtTime(dl.noShowAt, tz)}. Running late? Call the fleet desk before then.` : "The bay is held for your slot."}</div>
              </div>
            </li>
            <li>
              <div>
                <b>{plateEntry ? "Drive in, the barrier reads your plate" : "Enter with the code from your fleet desk"}</b>
                <div className="small muted">{pass.site.directions ?? "Follow the signs for HGV charging."}</div>
              </div>
            </li>
            <li>
              <div>
                <b>{pass.bay ? `Park in bay ${pass.bay} and plug in` : "Park in a free charging bay and plug in"}</b>
                <div className="small muted">{pass.start_method ? `${START_METHOD_LABEL[pass.start_method]} starts charging by itself. No card or app needed.` : "Charging starts by itself."} Unplug by {fmtTime(dl.stopBy, tz)}.</div>
              </div>
            </li>
          </ol>
        )}
      </div>

      {live && pass.session?.status !== "ACTIVE" && (
        <div className="pass-card">
          <div className="pass-hero" style={{ gap: 12 }}>
            <b>What happens on site</b>
            <ChargeStory
              audience="driver"
              truck={truckKindOf(pass.vehicle_type)}
              access={accessKindOf(pass.access_methods)}
              start={pass.start_method ?? "PLUG_AND_CHARGE"}
              plate={pass.plate}
              maxKw={pass.power_kw ?? 350}
            />
          </div>
        </div>
      )}

      {(pass.desk_phone || pass.brand.support_phone) && (
        <div className="pass-card">
          <div className="pass-hero" style={{ gap: 8 }}>
            <b>{pass.fleet_name}</b>
            {pass.driver_name && <span className="small muted">Booked for {pass.driver_name}</span>}
            <div className="row gap-8 wrap">
              {pass.desk_phone && <a className="btn" href={`tel:${pass.desk_phone.replace(/\s/g, "")}`}><Icon name="phone" size="sm" />Fleet desk</a>}
              {pass.brand.support_phone && <a className="btn ghost" href={`tel:${pass.brand.support_phone.replace(/\s/g, "")}`}>{pass.brand.name} support</a>}
            </div>
          </div>
        </div>
      )}
      <div className="pass-foot">
        Operated by {pass.site.operator}.{pass.brand.show_powered_by ? " Powered by Depotcharge." : ""}{" "}
        <a href="#/legal/privacy">Privacy</a>
      </div>
    </div>
  );
}
