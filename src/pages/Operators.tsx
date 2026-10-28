// Public page for charge point operators: what connecting to this platform involves, the OCPI
// details they need, and how to start. No sign-in; linked from the sign-in page and the README.
import { useEffect, useState } from "react";
import type { AppConfig } from "../../shared/model";
import { applyBrand } from "../app/brand";
import { href } from "../app/router";
import { BrandMark, Icon, copyText } from "../ui/ui";
import type { IconName } from "../ui/icon-data";
import { LegalFooter } from "../legal/LegalPage";

const SOURCE = "https://github.com/craig-weston/EV-Charging-booking-reservation-OCPI-app";

const BENEFITS: { icon: IconName; title: string; text: string }[] = [
  { icon: "today", title: "Booked HGV visits", text: "Fleets book a bay for a set window, so you see truck demand before it arrives and can plan power and staffing." },
  { icon: "scan", title: "Arrival by number plate", text: "Each booking carries the truck's plate for ANPR and its charging ID for Plug & Charge or Autocharge. No RFID cards." },
  { icon: "badgeCheck", title: "Your terms, your fees", text: "Booking, no-show and overstay fees come from your own booking terms and tariffs, and we settle them with you." },
  { icon: "shieldCheck", title: "Roaming that counts", text: "We're a third-party roaming provider, so connecting helps with the roaming requirement in the Public Charge Point Regulations 2023." },
];

const MODULES: [string, string, string][] = [
  ["Credentials", "Sender and receiver", "Registration both ways: you can send us a token, or we can send you one"],
  ["Locations", "Receiver, and we pull", "Sites, bays and connectors, including HGV restrictions"],
  ["Tariffs", "Receiver, and we pull", "Prices shown to planners before they book"],
  ["Bookings", "Receiver, and we pull your booking locations", "Booking requests, changes and cancellations, with calendars and booking terms"],
  ["Tokens", "Sender, with real-time authorisation", "The truck's plate and charging ID; we answer authorise calls in real time"],
  ["Sessions", "Receiver", "Live charging progress for planners"],
  ["CDRs", "Receiver", "Charge records: the basis for your invoice to us"],
];

const STEPS: { title: string; text: string }[] = [
  { title: "Get in touch", text: "Tell us which sites take HGVs and whether your platform offers OCPI 2.3.0 with Bookings. We agree a roaming agreement and fees." },
  { title: "Exchange credentials", text: "Send us your versions URL and a registration token, or ask us for ours. A test environment first is ideal." },
  { title: "We check your interface", text: "Before registering, we run a read-only check of your versions, endpoints, booking locations and calendars, and share the report." },
  { title: "Test booking, then live", text: "One booking end to end with your team watching: confirmation, arrival by plate, charging and the charge record." },
];

export function OperatorsPage({ config }: { config: AppConfig }) {
  const [online, setOnline] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    applyBrand(config.brand);
    document.title = `For charge point operators · ${config.brand.name}`;
    window.scrollTo(0, 0);
    // A plain health check: shows operators the platform is up without exposing anything.
    if (config.mode !== "live") return;
    fetch("/api/health", { headers: { Accept: "application/json" } })
      .then((r) => setOnline(r.ok))
      .catch(() => setOnline(false));
  }, [config.brand, config.mode]);
  const contact = config.legal.contact_email || config.brand.support_email;
  const copy = async () => { if (await copyText(config.ocpi_versions_url)) { setCopied(true); setTimeout(() => setCopied(false), 1800); } };

  return (
    <div className="legal ops">
      <header className="legal-head">
        <a href={href("/")} aria-label={`${config.brand.name} home`}><BrandMark brand={config.brand} /></a>
        <a className="btn ghost sm right" href={href("/")}>Sign in</a>
      </header>

      <main className="ops-main">
        <section className="ops-hero">
          <p className="ops-eyebrow">For charge point operators</p>
          <h1>Fill your HGV bays with booked trucks</h1>
          <p className="ops-lead">{config.brand.name} lets fleet planners book a charging bay at your site for a set window. The truck arrives by number plate, starts with Plug &amp; Charge or Autocharge, and we pay you for every charge. It all runs over OCPI 2.3.0 with the Bookings module.</p>
          <div className="row gap-8 wrap">
            {contact ? <a className="btn primary lg" href={`mailto:${contact}?subject=${encodeURIComponent(`Connecting to ${config.brand.name} over OCPI`)}`}><Icon name="message" size="sm" />Talk to us</a> : <a className="btn primary lg" href={`${SOURCE}/issues/new`} target="_blank" rel="noreferrer"><Icon name="message" size="sm" />Talk to us</a>}
            <a className="btn lg" href="#/demo" onClick={(e) => { e.preventDefault(); window.location.hash = "#/demo"; window.location.reload(); }}><Icon name="play" size="sm" />See the planner's side</a>
          </div>
          {contact && <p className="xs muted">Or email <b>{contact}</b></p>}
        </section>

        <section className="ops-benefits" aria-label="Why connect">
          {BENEFITS.map((b) => (
            <div key={b.title} className="ops-benefit">
              <span className="ops-icon" aria-hidden="true"><Icon name={b.icon} /></span>
              <h2>{b.title}</h2>
              <p>{b.text}</p>
            </div>
          ))}
        </section>

        <section className="ops-section">
          <h2>How a booked visit works</h2>
          <ol className="ops-flow">
            <li><b>A planner books</b><span>We send a booking request for one of your booking locations, with the plate and charging ID.</span></li>
            <li><b>You confirm</b><span>Synchronously or later; the planner sees "Waiting for operator" until you answer.</span></li>
            <li><b>The truck arrives</b><span>Your barrier reads the plate; the charger recognises the truck. You can ask us to authorise in real time.</span></li>
            <li><b>Charging and the record</b><span>You send sessions and the CDR with the booking reference. We invoice the fleet and pay you.</span></li>
          </ol>
        </section>

        <section className="ops-section">
          <div className="ops-head-row">
            <h2>Our OCPI details</h2>
            {config.mode === "live" && <span className={`status ${online ? "ok" : online === false ? "bad" : "muted"}`}>{online ? "Interface online" : online === false ? "Not reachable right now" : "Checking…"}</span>}
          </div>
          <dl className="ops-facts">
            <div><dt>Version</dt><dd>OCPI 2.3.0 with Bookings</dd></div>
            <div><dt>Role</dt><dd>EMSP</dd></div>
            <div><dt>Country code / party ID</dt><dd>{config.party.country_code} / {config.party.party_id}</dd></div>
            <div><dt>Business name</dt><dd>{config.party.name}</dd></div>
            <div className="wide"><dt>Versions URL</dt><dd className="ops-url"><code>{config.ocpi_versions_url}</code><button type="button" className="btn sm" onClick={copy}><Icon name={copied ? "check" : "copy"} size="sm" />{copied ? "Copied" : "Copy"}</button></dd></div>
          </dl>
          <div className="table-scroll">
            <table className="ops-table">
              <thead><tr><th scope="col">Module</th><th scope="col">Our role</th><th scope="col">What it's for</th></tr></thead>
              <tbody>{MODULES.map(([m, r, w]) => <tr key={m}><th scope="row">{m}</th><td>{r}</td><td>{w}</td></tr>)}</tbody>
            </table>
          </div>
          <p className="small muted">Requests carry X-Request-ID and X-Correlation-ID. Tokens you give us are stored encrypted. Every message is logged for 30 days so we can trace a booking with you.</p>
        </section>

        <section className="ops-section">
          <h2>Connecting, step by step</h2>
          <ol className="ops-steps">
            {STEPS.map((s, i) => <li key={s.title}><span className="ops-num" aria-hidden="true">{i + 1}</span><div><b>{s.title}</b><p>{s.text}</p></div></li>)}
          </ol>
          <h3 className="ops-h3">What helps us book your bays</h3>
          <ul className="ops-list">
            <li>Booking locations for HGV bays, with vehicle limits (length, height, weight) and connector types</li>
            <li>Calendars with free slots, and booking terms: change and cancel windows, no-show and overstay fees</li>
            <li>Access by number plate (ANPR) or no access control, so drivers need no card</li>
            <li>Plug &amp; Charge (ISO 15118) or Autocharge on the chargers</li>
          </ul>
        </section>

        <section className="ops-section ops-open">
          <div>
            <h2>Open source, so you can check our side</h2>
            <p>{config.brand.name} is Apache 2.0 licensed. Your integration team can read exactly how we handle bookings, tokens and charge records, and run our read-only OCPI check against their own interface.</p>
          </div>
          <div className="row gap-8 wrap">
            <a className="btn" href={SOURCE} target="_blank" rel="noreferrer"><Icon name="external" size="sm" />Source code</a>
            <a className="btn ghost" href={href("/legal/security")}><Icon name="shield" size="sm" />Security</a>
          </div>
        </section>
      </main>
      <LegalFooter config={config} />
    </div>
  );
}
