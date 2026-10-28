import { useEffect, useState } from "react";
import type { Brand, Fleet, NotifyChannel } from "../../shared/model";
import { DEFAULT_BRAND } from "../../shared/model";
import { useApp, type Theme } from "../app/state";
import { ApiFailure } from "../app/backend";
import { BRAND_SWATCHES, applyBrand } from "../app/brand";
import { BrandMark, Field, Icon, Plate, Seg, Spinner, Switch } from "../ui/ui";
import { TeamSettings } from "./Team";
import { SecuritySettings } from "./Security";
import { ApiKeySettings } from "./ApiKeys";
import { WebhookSettings } from "./Webhooks";
import { ChargingMini } from "../components/art/Mini";
import { href } from "../app/router";
import { LEGAL_DOCS } from "../legal/documents";

export function SettingsPage() {
  const { me, fleet, fleetId, backend, theme, setTheme } = useApp();
  const role = me?.memberships.find((m) => m.fleet_id === fleetId)?.role;
  return (
    <div className="page">
      <div className="page-head"><div><h1>Settings</h1><div className="sub">Your fleet, how the app looks, and the brand your customers and drivers see.</div></div></div>
      <div className="settings-grid">
        <nav className="settings-nav" aria-label="Settings sections">
          <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-fleet")?.scrollIntoView({ behavior: "smooth" }); }}>Fleet</a>
          <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-team")?.scrollIntoView({ behavior: "smooth" }); }}>Team</a>
          <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-security")?.scrollIntoView({ behavior: "smooth" }); }}>Security</a>
          {role === "owner" && <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-api")?.scrollIntoView({ behavior: "smooth" }); }}>API keys</a>}
          {role === "owner" && <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-webhooks")?.scrollIntoView({ behavior: "smooth" }); }}>Webhooks</a>}
          {me?.is_admin && <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-brand")?.scrollIntoView({ behavior: "smooth" }); }}>Branding</a>}
          <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-look")?.scrollIntoView({ behavior: "smooth" }); }}>Appearance</a>
          <a href="#/settings" onClick={(e) => { e.preventDefault(); document.getElementById("s-account")?.scrollIntoView({ behavior: "smooth" }); }}>Account</a>
          {me?.is_admin && <a href={href("/compliance")}>Security & compliance</a>}
        </nav>
        <div className="stack gap-24">
          {fleet && <FleetSettings fleet={fleet} canEdit={role === "owner"} />}
          {fleet && <TeamSettings canManage={role === "owner"} />}
          <SecuritySettings />
          {fleet && role === "owner" && <ApiKeySettings />}
          {fleet && role === "owner" && <WebhookSettings />}
          {me?.is_admin && <BrandSettings />}
          <section className="panel" id="s-look">
            <div className="panel-head"><h2>Appearance</h2></div>
            <div className="panel-body stack gap-8">
              <Seg<Theme> label="Theme" value={theme} onChange={setTheme} options={[{ value: "system", label: "Match device" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
              <span className="hint">Only changes this browser.</span>
            </div>
          </section>
          <section className="panel" id="s-account">
            <div className="panel-head"><h2>Account</h2></div>
            <div className="panel-body stack gap-12">
              {backend.mode === "demo" ? (
                <>
                  <p className="small">You're in demo mode: the API, the OCPI interface and a simulated network of operators run inside this browser tab, and data is saved in this browser only.</p>
                  <div><button className="btn" onClick={() => backend.reset?.()}><Icon name="undo" size="sm" />Reset demo data</button></div>
                </>
              ) : (
                <>
                  <p className="small">Signed in as <b>{me?.user.email}</b>{role ? `, ${role} of ${fleet?.name}` : ""}.</p>
                  <div><button className="btn" onClick={() => backend.auth?.signOut().then(() => window.location.reload())}><Icon name="logOut" size="sm" />Sign out</button></div>
                </>
              )}
              <div className="divider" />
              <nav className="row gap-12 wrap small" aria-label="Legal">
                {LEGAL_DOCS.map((d) => <a key={d.id} href={href(`/legal/${d.id}`)}>{d.title}</a>)}
              </nav>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function FleetSettings({ fleet, canEdit }: { fleet: Fleet; canEdit: boolean }) {
  const { api, fleetId, refreshFleet, refreshMe, toast, config } = useApp();
  const [name, setName] = useState(fleet.name);
  const [notify, setNotify] = useState<NotifyChannel>(fleet.notify_drivers ?? "off");
  const channels = config.notifications ?? { sms: false, whatsapp: false };
  const [phone, setPhone] = useState(fleet.desk_phone ?? "");
  const [unbooked, setUnbooked] = useState(fleet.allow_unbooked_charging);
  const [saving, setSaving] = useState(false);
  const dirty = name !== fleet.name || phone !== (fleet.desk_phone ?? "") || unbooked !== fleet.allow_unbooked_charging || notify !== (fleet.notify_drivers ?? "off");
  const save = async () => {
    setSaving(true);
    try {
      await api("PATCH", `/fleets/${fleetId}`, { name, desk_phone: phone, allow_unbooked_charging: unbooked, notify_drivers: notify });
      await Promise.all([refreshFleet(), refreshMe()]);
      toast("Fleet settings saved");
    } catch (e) {
      toast(e instanceof ApiFailure ? e.message : "Couldn't save", "bad");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="panel" id="s-fleet">
      <div className="panel-head"><h2>Fleet</h2></div>
      <div className="panel-body stack gap-16">
        <div className="form-grid">
          <Field label="Fleet name">{(id) => <input id={id} className="input" value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Fleet desk phone" hint="Shown on driver passes">{(id) => <input id={id} className="input" type="tel" value={phone} disabled={!canEdit} onChange={(e) => setPhone(e.target.value)} placeholder="0161 496 0000" />}</Field>
        </div>
        <Switch checked={unbooked} onChange={(v) => canEdit && setUnbooked(v)}>
          <span>Allow charging without a booking</span>
          <span className="hint" style={{ display: "block" }}>When an operator asks us to authorise one of your trucks and there's no booking, answer "allowed". Turn off to only pay for booked sessions.</span>
        </Switch>
        <Field label="Message drivers automatically" hint={channels.sms || channels.whatsapp
          ? "When a booking is confirmed, changed or cancelled, the assigned driver gets their pass link. Uses the phone number on the driver's profile."
          : "Not set up on this platform yet: your platform admin needs to add the Twilio settings."}>
          {(id) => (
            <select id={id} className="input" value={notify} disabled={!canEdit} onChange={(e) => setNotify(e.target.value as NotifyChannel)}>
              <option value="off">Off: we'll share the pass link ourselves</option>
              <option value="sms" disabled={!channels.sms && notify !== "sms"}>Text message (SMS)</option>
              <option value="whatsapp" disabled={!channels.whatsapp && notify !== "whatsapp"}>WhatsApp</option>
            </select>
          )}
        </Field>
        {canEdit && <div><button className="btn primary" disabled={!dirty || saving} onClick={save}>{saving && <Spinner />}Save fleet settings</button></div>}
      </div>
    </section>
  );
}

function BrandSettings() {
  const { api, brand, setBrand, toast, theme } = useApp();
  const [draft, setDraft] = useState<Brand>(brand);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(brand), [brand]);
  // Live preview across the whole app while editing; reverted on unmount if not saved.
  useEffect(() => {
    applyBrand(draft, theme);
    return () => applyBrand(brand, theme);
  }, [draft, brand, theme]);

  const set = <K extends keyof Brand>(k: K, v: Brand[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const onLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 100_000) { setError("Use a logo under 100 KB (SVG works best)"); return; }
    const r = new FileReader();
    r.onload = () => { set("logo_url", String(r.result)); setError(null); };
    r.readAsDataURL(file);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await api<Brand>("PUT", "/admin/brand", draft);
      setBrand(saved);
      toast("Branding saved for everyone");
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't save the branding");
    } finally {
      setSaving(false);
    }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(brand);
  return (
    <section className="panel" id="s-brand">
      <div className="panel-head"><h2>Branding</h2><span className="right xs muted">White label</span></div>
      <div className="panel-body stack gap-16">
        <p className="small muted">One name, one logo and one colour theme the whole product: planners' screens, sign-in and every driver pass. Hover, focus and highlight shades are derived from the colour automatically.</p>
        <div className="form-grid">
          <Field label="Product name">{(id) => <input id={id} className="input" value={draft.name} maxLength={40} onChange={(e) => set("name", e.target.value)} />}</Field>
          <div className="field">
            <label htmlFor="brand-color">Brand colour</label>
            <div className="row gap-8">
              <input id="brand-color" type="color" value={draft.primary_color} onChange={(e) => set("primary_color", e.target.value)} style={{ width: 44, height: 38, padding: 2, border: "1px solid var(--line-2)", borderRadius: 7, background: "var(--surface)" }} />
              <input className="input" value={draft.primary_color} onChange={(e) => /^#?[0-9a-f]{0,6}$/i.test(e.target.value) && set("primary_color", e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`)} aria-label="Hex colour" style={{ fontFamily: "var(--mono)", width: 110 }} />
            </div>
            <div className="swatches" style={{ marginTop: 4 }}>
              {BRAND_SWATCHES.map((c) => <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Use ${c}`} aria-pressed={draft.primary_color.toLowerCase() === c.toLowerCase()} onClick={() => set("primary_color", c)} />)}
            </div>
          </div>
          <div className="field span-2">
            <span className="label">Logo</span>
            <div className="row gap-8 wrap">
              <label className="btn sm"><Icon name="upload" size="sm" />Upload SVG or PNG<input type="file" accept="image/svg+xml,image/png,image/webp,image/jpeg" hidden onChange={(e) => onLogo(e.target.files?.[0])} /></label>
              <input className="input" style={{ maxWidth: 360 }} placeholder="or paste an https:// logo URL" value={draft.logo_url.startsWith("data:") ? "" : draft.logo_url} onChange={(e) => set("logo_url", e.target.value)} />
              {draft.logo_url && <button className="btn sm ghost" onClick={() => set("logo_url", "")}>Use monogram</button>}
            </div>
            <span className="hint">Shown at up to 30 px high. Leave empty to use a monogram of the name.</span>
          </div>
          <Field label="Support email">{(id) => <input id={id} className="input" type="email" value={draft.support_email} onChange={(e) => set("support_email", e.target.value)} placeholder="Optional" />}</Field>
          <Field label="Support phone">{(id) => <input id={id} className="input" type="tel" value={draft.support_phone} onChange={(e) => set("support_phone", e.target.value)} placeholder="Optional" />}</Field>
        </div>
        <Switch checked={draft.show_powered_by} onChange={(v) => set("show_powered_by", v)}>Show a small "Powered by" line on driver passes</Switch>

        <div className="preview" aria-label="Preview">
          <div className="row gap-12 wrap" style={{ padding: 14, background: "var(--surface)", borderBottom: "1px solid var(--line)" }}>
            <BrandMark brand={draft} />
            <span className="grow" />
            <button className="btn primary sm" type="button">Book a slot</button>
          </div>
          <div className="row gap-12 wrap" style={{ padding: 14 }}>
            <Plate plate="PN74 EVH" />
            <span className="chip on">Tomorrow</span>
            <span className="status ok">Reserved</span>
            <a href="#/settings" onClick={(e) => e.preventDefault()}>Operator booking terms</a>
          </div>
          <div style={{ padding: "0 14px 14px", maxWidth: 380 }}>
            <ChargingMini size="lg" kw={350} label="Illustrations use the brand colour" />
          </div>
        </div>
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="row gap-8">
          <button className="btn primary" disabled={!dirty || saving} onClick={save}>{saving && <Spinner />}Save branding</button>
          {dirty && <button className="btn ghost" onClick={() => setDraft(brand)}>Discard changes</button>}
          <button className="btn ghost right" onClick={() => setDraft({ ...DEFAULT_BRAND })}>Restore defaults</button>
        </div>
      </div>
    </section>
  );
}
