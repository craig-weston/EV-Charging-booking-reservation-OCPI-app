// The platform's legal documents, filled in from Settings → Company & legal. Anything not set yet
// is shown as a highlighted placeholder so it can't go unnoticed. Written for a UK business-to-
// business service under UK GDPR, the Data Protection Act 2018 (as amended by the Data (Use and
// Access) Act 2025), PECR, the Companies Act 2006 and the Electronic Commerce Regulations 2002.
// Have them reviewed by a solicitor before launch.
import type { ReactNode } from "react";
import type { Brand, Certification, LegalInfo } from "../../shared/model";

export const LEGAL_UPDATED = "21 October 2026";

export type LegalDocId = "privacy" | "terms" | "dpa" | "cookies" | "security" | "accessibility" | "licences";

export const LEGAL_DOCS: { id: LegalDocId; title: string; short: string }[] = [
  { id: "privacy", title: "Privacy notice", short: "Privacy" },
  { id: "terms", title: "Terms of service", short: "Terms" },
  { id: "dpa", title: "Data processing terms", short: "Data processing" },
  { id: "cookies", title: "Cookies and storage", short: "Cookies" },
  { id: "security", title: "Security", short: "Security" },
  { id: "accessibility", title: "Accessibility statement", short: "Accessibility" },
  { id: "licences", title: "Third-party licences", short: "Licences" },
];

interface Ctx {
  info: LegalInfo;
  brand: Brand;
  certifications: Certification[];
  version: string;
}

/** A value from the company settings, or a visible placeholder. */
function V({ v, ph }: { v: string; ph: string }) {
  return v ? <>{v}</> : <mark className="unset" title="Set this in Settings → Security & compliance → Company & legal">[{ph}]</mark>;
}

function Mail({ v, ph }: { v: string; ph: string }) {
  return v ? <a href={`mailto:${v}`}>{v}</a> : <V v="" ph={ph} />;
}

function Who({ c }: { c: Ctx }) {
  const i = c.info;
  return (
    <p>
      {c.brand.name} is provided by <b><V v={i.company_name} ph="Company legal name" /></b>
      {i.trading_name && i.trading_name !== i.company_name ? <> (trading as {i.trading_name})</> : null}, a company registered in {i.place_of_registration || "England and Wales"} with
      company number <V v={i.company_number} ph="Company number" />, whose registered office is at <V v={i.registered_office} ph="Registered office address" />
      {i.vat_number ? <>. VAT number {i.vat_number}</> : null}. Contact: <Mail v={i.contact_email} ph="Contact email" />.
    </p>
  );
}

export function LegalDocument({ id, c }: { id: LegalDocId; c: Ctx }): ReactNode {
  switch (id) {
    case "privacy": return <Privacy c={c} />;
    case "terms": return <Terms c={c} />;
    case "dpa": return <Dpa c={c} />;
    case "cookies": return <Cookies c={c} />;
    case "security": return <Security c={c} />;
    case "accessibility": return <Accessibility c={c} />;
    case "licences": return <Licences />;
  }
}

// ------------------------------------------------------------------ privacy notice

function Privacy({ c }: { c: Ctx }) {
  const i = c.info;
  const n = c.brand.name;
  return (
    <>
      <p className="lead">This notice explains what personal data {n} handles, why, who sees it and your rights. We keep it short and plain; ask us if anything is unclear.</p>
      <h2>Who we are</h2>
      <Who c={c} />
      <p>
        For data protection questions or requests, email <Mail v={i.privacy_email || i.contact_email} ph="Privacy email" />.
        We are registered with the Information Commissioner's Office (ICO) under registration number <V v={i.ico_number} ph="ICO registration number" />.
      </p>

      <h2>Two roles: ours and your organisation's</h2>
      <p>
        {n} is a business service. Fleet operators (our customers) use it to book charging slots for their vehicles at other operators' depots and hubs.
      </p>
      <ul>
        <li><b>We are the controller</b> for the accounts of the people who sign in (for example planners and fleet owners), for keeping the service secure, and for running our business.</li>
        <li><b>Your organisation is the controller</b> for its fleet data: vehicles and number plates, drivers' names and phone numbers, bookings, charging sessions and driver passes. We process that data on its behalf under our <a href="#/legal/dpa">data processing terms</a>. If you are a driver, your employer or the fleet that booked for you is your first point of contact.</li>
        <li><b>Charge point operators</b> receive what they need to give a booked vehicle access and charge it: the booking time, the number plate and the vehicle's charging identifier. They use it as independent controllers under their own privacy notices.</li>
      </ul>

      <h2>What we collect and why</h2>
      <table className="legal-table">
        <thead><tr><th>Data</th><th>Why</th><th>Lawful basis (UK GDPR Art. 6)</th></tr></thead>
        <tbody>
          <tr><td>Your work email address, password (stored only as a salted hash by our sign-in provider) and two-step verification settings</td><td>To create your account, sign you in and keep it secure</td><td>Legitimate interests: providing the service your organisation has asked for</td></tr>
          <tr><td>Your role on a fleet team and who invited you</td><td>To control what you can see and do</td><td>Legitimate interests</td></tr>
          <tr><td>Fleet data your organisation enters: vehicles and plates, drivers' names and phone numbers, notes, bookings</td><td>To book and manage charging, and to give drivers a pass</td><td>We process it for your organisation (it decides the basis, usually contract or legitimate interests)</td></tr>
          <tr><td>Charging data from operators: session times, energy, battery level, prices and charge records</td><td>To show live charging and costs</td><td>As above</td></tr>
          <tr><td>Security records: sign-in events, IP addresses, an audit log of changes such as role changes, exports and deletions</td><td>To protect accounts and the service, investigate incidents and prove who did what</td><td>Legitimate interests: security of our systems and your data</td></tr>
          <tr><td>Messages you send us</td><td>To answer and help</td><td>Legitimate interests</td></tr>
          <tr><td>Billing and contract records</td><td>To invoice and keep accounts</td><td>Contract and legal obligation</td></tr>
        </tbody>
      </table>
      <p>We do not sell personal data, use it for advertising, track you across other sites, or make decisions about people by automated means that have legal or similarly significant effects. We don't need special category data; please don't put health or similar details in notes fields.</p>

      <h2>Who we share it with</h2>
      <ul>
        <li><b>Charge point operators</b> you book with, as described above, and only for the bookings you make.</li>
        <li><b>Our suppliers</b> who host and run the service for us under contract (processors): see the list in the <a href="#/legal/dpa">data processing terms</a>.</li>
        <li><b>Your colleagues</b> on the same fleet team, according to their role.</li>
        <li><b>Authorities</b> when the law requires it, and professional advisers under confidentiality.</li>
      </ul>

      <h2>International transfers</h2>
      <p>
        Our database is hosted in <V v={i.hosting_region} ph="Hosting region, e.g. London, UK" />. Some suppliers (for example our content delivery network) may process data elsewhere, including the USA.
        When personal data leaves the UK we rely on UK adequacy regulations or on the safeguards the law requires: the International Data Transfer Agreement or the UK Addendum to the EU Standard
        Contractual Clauses, or the UK Extension to the EU–US Data Privacy Framework for certified US companies.
      </p>

      <h2>How long we keep it</h2>
      <table className="legal-table">
        <tbody>
          <tr><td>Your account</td><td>Until you delete it (Settings → Security → Delete my account) or your organisation asks us to</td></tr>
          <tr><td>Fleet data</td><td>While your organisation uses {n}; deleted when the fleet is deleted. Bookings and charge records are kept for at most 6 years after the booking for accounting and disputes</td></tr>
          <tr><td>Messages exchanged with operators (OCPI log)</td><td>30 days</td></tr>
          <tr><td>Security audit log</td><td>12 months (the email of someone who deletes their account is removed from it straight away)</td></tr>
          <tr><td>Unused or expired invite links</td><td>30 days</td></tr>
          <tr><td>Backups</td><td>Deleted data can remain in encrypted backups for up to 30 days before they are overwritten</td></tr>
        </tbody>
      </table>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your personal data, have it corrected, deleted or restricted, object to our use of it, and receive it in a portable format. Fleet owners can export their fleet's data
        and delete the fleet themselves in Settings. To use your rights, email <Mail v={i.privacy_email || i.contact_email} ph="Privacy email" />. We may need to check it's you, and we
        reply within one month. If the data belongs to a fleet's records, we'll pass your request to that organisation and help it respond.
      </p>
      <h2>Complaints</h2>
      <p>
        If you're unhappy with how we've handled your data, please complain to us first at <Mail v={i.privacy_email || i.contact_email} ph="Privacy email" />. We acknowledge complaints within
        30 days and investigate without undue delay. You can also complain to the Information Commissioner's Office: <a href="https://ico.org.uk/make-a-complaint/" target="_blank" rel="noreferrer">ico.org.uk/make-a-complaint</a>, 0303 123 1113.
      </p>
      <h2>Security</h2>
      <p>See <a href="#/legal/security">Security</a> for how we protect data. Cookies and browser storage are explained in <a href="#/legal/cookies">Cookies and storage</a>.</p>
      <h2>Changes</h2>
      <p>We'll update this notice when our processing changes and tell account holders about significant changes. Version {c.version}, last updated {LEGAL_UPDATED}.</p>
    </>
  );
}

// ------------------------------------------------------------------ terms of service

function Terms({ c }: { c: Ctx }) {
  const n = c.brand.name;
  const company = c.info.company_name;
  return (
    <>
      <p className="lead">These terms apply between <b><V v={company} ph="Company legal name" /></b> ("we", "us") and the organisation that creates a fleet on {n} ("you", "the Customer"). They form the contract for the service together with any order form we agree with you, which wins if the two conflict.</p>
      <Who c={c} />
      <p>The person who accepts these terms on your behalf confirms they are authorised to do so. {n} is for businesses; it is not offered to consumers.</p>

      <h2>1. The service</h2>
      <p>{n} lets you book charging slots for your vehicles at sites run by charge point operators ("Operators"), using the OCPI protocol. Operators decide which bays they offer, their availability, prices and booking terms (including cancellation, no-show and overstay rules), and they confirm or decline each booking. We pass your requests and their answers on accurately and promptly, but we don't run the sites or the chargers.</p>
      <p>Test features, such as the built-in operator simulator and demo mode, are provided as they are and must not be relied on for real bookings.</p>

      <h2>2. Accounts and security</h2>
      <ul>
        <li>Each user needs their own account; don't share sign-in details. You decide who is on your team and their role, and you remove people who no longer need access.</li>
        <li>Turn on two-step verification for your team (Settings → Security). You can require it for everyone; platform administrators must use it.</li>
        <li>Tell us straight away at <Mail v={c.info.security_contact.includes("@") ? c.info.security_contact : c.info.contact_email} ph="Security contact" /> if you suspect unauthorised access.</li>
      </ul>

      <h2>3. Your responsibilities</h2>
      <ul>
        <li>Keep vehicle details accurate, especially number plates and charging identifiers: they open site barriers and start charging.</li>
        <li>Make sure you may share drivers' and vehicles' details with us and with the Operators you book with, and tell your drivers how their data is used (our <a href="#/legal/privacy">privacy notice</a> can help).</li>
        <li>Make sure drivers follow each site's rules and the Operator's booking terms.</li>
        <li>Pay the fees in your order form or plan on time.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>Don't use {n} unlawfully or to harm anyone; don't try to get around security or access controls, overload the service, scrape it, or probe it for vulnerabilities without our written permission (but do report any you find, see <a href="#/legal/security">Security</a>); don't upload malicious code; and don't resell access. We may suspend access that puts the service, other customers or Operators at risk, telling you why as soon as we can.</p>

      <h2>5. Bookings, charging and fees</h2>
      <p>Each booking is made with the Operator on the Operator's booking terms, which we show before you book. Booking fees, no-show fees and charging costs are set by the Operator. How those charges and our own fees are invoiced and paid is set out in your order form or plan. Prices are shown excluding VAT unless stated.</p>

      <h2>6. Your data</h2>
      <p>You own your data. We process personal data in it on your behalf under our <a href="#/legal/dpa">data processing terms</a>, which form part of these terms. You can export your data and delete your fleet at any time in Settings.</p>

      <h2>7. Confidentiality</h2>
      <p>Each of us keeps the other's confidential information confidential and uses it only for this contract, except where it is already public or disclosure is required by law.</p>

      <h2>8. Intellectual property</h2>
      <p>We (and our licensors) own {n} and everything in it. While these terms apply you may use it for your own business. If you send us feedback we may use it freely.</p>

      <h2>9. Availability and support</h2>
      <p>We aim to keep {n} available and secure and to fix faults promptly, but we don't promise uninterrupted service unless your order form includes a service level. We provide security updates for as long as we provide the service. We may change features; we'll tell you in good time about changes that reduce what you use. If we decide to stop providing {n} altogether, we'll give you at least 12 months' notice, unless the law or circumstances outside our control make that impossible.</p>

      <h2>10. Liability</h2>
      <p>Nothing in these terms limits liability for death or personal injury caused by negligence, for fraud, or for anything else that cannot legally be limited. Otherwise, neither of us is liable for loss of profit, revenue, business, goodwill or anticipated savings, or for indirect or consequential loss; and each party's total liability under or in connection with this contract in any 12-month period is limited to the fees paid or payable by you in that period (or £1,000 if greater). We are not responsible for Operators' sites, equipment, availability or charges, although we will help you resolve problems with them.</p>

      <h2>11. Ending the contract</h2>
      <p>You can stop using {n} and delete your fleet at any time, subject to your order form. Either of us may end the contract if the other materially breaches it and doesn't fix the breach within 30 days of notice. After it ends you have 30 days to export your data; then we delete it, except what we must keep by law.</p>

      <h2>12. Changes to these terms</h2>
      <p>We may update these terms. We'll give fleet owners at least 30 days' notice of material changes and ask them to accept the new version in the app. The current version is {c.version}, last updated {LEGAL_UPDATED}.</p>

      <h2>13. General</h2>
      <p>These terms and your order form are the whole agreement between us about the service. Neither of us may transfer the contract without the other's consent, except to a successor of the whole business. Nobody else has rights under it (Contracts (Rights of Third Parties) Act 1999). If part of it is unenforceable, the rest still applies. The contract and any dispute about it are governed by the law of England and Wales, and the courts of England and Wales have exclusive jurisdiction.</p>
    </>
  );
}

// ------------------------------------------------------------------ data processing terms

function Dpa({ c }: { c: Ctx }) {
  const i = c.info;
  const n = c.brand.name;
  return (
    <>
      <p className="lead">These terms form part of the <a href="#/legal/terms">terms of service</a>. They meet Article 28(3) of the UK GDPR for personal data we process on the Customer's behalf ("Customer Personal Data").</p>
      <h2>1. Roles</h2>
      <p>The Customer is the controller and <V v={i.company_name} ph="Company legal name" /> is the processor of Customer Personal Data. Each party complies with UK data protection law.</p>
      <h2>2. Our commitments as processor</h2>
      <ol>
        <li><b>Instructions.</b> We process Customer Personal Data only on the Customer's documented instructions, which are these terms and the Customer's use of {n}, including transfers, unless the law requires otherwise (we'll say so first unless the law forbids it). We tell the Customer if we think an instruction breaks the law.</li>
        <li><b>Operators.</b> When the Customer books a slot, it instructs us to send the booking details (time, number plate, vehicle charging identifier) to the chosen charge point operator, which then acts as an independent controller.</li>
        <li><b>Confidentiality.</b> Everyone we authorise to process Customer Personal Data is bound by confidentiality.</li>
        <li><b>Security.</b> We apply the technical and organisational measures in Annex B and keep them up to date.</li>
        <li><b>Sub-processors.</b> The Customer authorises the sub-processors in Annex C. We give at least 30 days' notice of a new one by email to fleet owners; the Customer may object on reasonable data protection grounds, and if we can't resolve the objection it may end the contract. We impose the same data protection obligations on sub-processors and remain responsible for them.</li>
        <li><b>Data subjects' rights.</b> {n} lets the Customer correct, export and delete its data itself; we also help with requests where reasonably possible.</li>
        <li><b>Breaches.</b> We notify the Customer without undue delay, and in any event within 48 hours, after becoming aware of a personal data breach affecting Customer Personal Data, with the information the Customer needs to meet its own obligations, and we help contain it.</li>
        <li><b>Other help.</b> We help the Customer with security, breach notification, data protection impact assessments and prior consultation, taking into account the nature of the processing and the information available to us.</li>
        <li><b>End of service.</b> When the contract ends the Customer can export its data for 30 days; then we delete Customer Personal Data unless the law requires us to keep it. Backups are overwritten within a further 30 days.</li>
        <li><b>Audits.</b> We make available the information needed to show compliance with these terms (including our security documentation and certifications) and allow audits by the Customer or its auditor, on 30 days' notice, no more than once a year unless there has been a breach, at the Customer's cost and subject to confidentiality.</li>
        <li><b>Transfers.</b> We transfer Customer Personal Data out of the UK only with the safeguards UK law requires (see the privacy notice).</li>
      </ol>

      <h2>Annex A: details of the processing</h2>
      <table className="legal-table">
        <tbody>
          <tr><th>Subject matter</th><td>Providing {n}: booking charging slots, sharing booking details with charge point operators, receiving charging sessions and charge records</td></tr>
          <tr><th>Duration</th><td>The term of the contract, plus the deletion periods above</td></tr>
          <tr><th>Nature and purpose</th><td>Storage, organisation, retrieval, transmission to operators, display and deletion, to operate the service</td></tr>
          <tr><th>Personal data</th><td>Team members' work email addresses and roles; drivers' names and phone numbers; vehicle number plates and charging identifiers (contract or vehicle IDs); booking times and places; charging session data (times, energy, battery level, cost); notes</td></tr>
          <tr><th>Data subjects</th><td>The Customer's staff and drivers (employees, agency workers or subcontractors), and sole-trader drivers</td></tr>
          <tr><th>Special category data</th><td>None expected</td></tr>
        </tbody>
      </table>

      <h2>Annex B: security measures</h2>
      <ul>
        <li>Encryption in transit (TLS 1.2 or higher, HSTS) for every connection, including to operators; encryption at rest of the database and its backups; operator credentials encrypted at the application level (AES-256-GCM) or stored only as SHA-256 hashes.</li>
        <li>Access control: role-based permissions (owner, planner, viewer), row level security in the database, single-use expiring invites, two-step verification (required for platform administrators and optionally for whole fleets), least-privilege service keys held only on the server.</li>
        <li>Protection of the service: strict Content-Security-Policy and security headers, rate limiting, request size limits, input validation, sanitised uploads, an audit log of security-relevant actions.</li>
        <li>Secure development: code review, automated tests (including security tests) and dependency vulnerability checks on every change; high and critical fixes applied within 14 days.</li>
        <li>Resilience: managed infrastructure with backups and a documented restore procedure; an incident response plan.</li>
        <li>People and organisation: confidentiality obligations, security awareness, controls aligned with the UK Cyber Essentials scheme{c.certifications.some((x) => x.scheme.startsWith("Cyber Essentials")) ? " (certified, see Security)" : ""}.</li>
      </ul>

      <h2>Annex C: sub-processors</h2>
      <table className="legal-table">
        <thead><tr><th>Sub-processor</th><th>Service</th><th>Location</th></tr></thead>
        <tbody>
          <tr><td>Cloudflare, Inc.</td><td>Hosting of the web application and API, content delivery, network security</td><td>Global network; UK/EU and USA</td></tr>
          <tr><td>Supabase, Inc.</td><td>Database and sign-in (authentication)</td><td><V v={i.hosting_region} ph="Hosting region, e.g. London, UK" /> (on Amazon Web Services); support from the USA</td></tr>
          <tr><td><V v={i.email_provider} ph="Email delivery provider" /></td><td>Delivery of sign-in and invitation emails</td><td>As stated by the provider</td></tr>
        </tbody>
      </table>
      <p className="small muted">Version {c.version}, last updated {LEGAL_UPDATED}.</p>
    </>
  );
}

// ------------------------------------------------------------------ cookies and storage

function Cookies({ c }: { c: Ctx }) {
  const n = c.brand.name;
  return (
    <>
      <p className="lead">{n} sets no advertising or analytics cookies, and loads nothing from third parties: even the typeface is served from our own site. That's why there's no cookie banner.</p>
      <p>The app stores a few items in your browser's local storage so it works as you'd expect. Under the Privacy and Electronic Communications Regulations these are either strictly necessary for the service you asked for, or remember a choice you made.</p>
      <table className="legal-table">
        <thead><tr><th>Name</th><th>What it does</th><th>Type</th><th>Kept</th></tr></thead>
        <tbody>
          <tr><td><code>depotcharge.session</code></td><td>Keeps you signed in (your sign-in session tokens)</td><td>Strictly necessary</td><td>Until you sign out or the session ends</td></tr>
          <tr><td><code>depotcharge.invite</code></td><td>Remembers an invite link while you create your account</td><td>Strictly necessary</td><td>Removed once you've joined</td></tr>
          <tr><td><code>depotcharge.fleet</code></td><td>Remembers which fleet you were looking at</td><td>Your choice</td><td>Until you clear it</td></tr>
          <tr><td><code>depotcharge.theme</code></td><td>Remembers light or dark appearance</td><td>Your choice</td><td>Until you clear it</td></tr>
          <tr><td><code>depotcharge.dismissed</code></td><td>Remembers alerts you dismissed on the dashboard</td><td>Your choice</td><td>Until you clear it</td></tr>
          <tr><td><code>depotcharge.demo.v1</code></td><td>Demo mode only: the demo's data, kept in your browser</td><td>Strictly necessary</td><td>Until you reset the demo</td></tr>
        </tbody>
      </table>
      <p>Our hosting provider, Cloudflare, may set security cookies (such as <code>__cf_bm</code> or <code>cf_clearance</code>) to tell people from bots and protect the service. They are strictly necessary and contain no information about what you do in {n}.</p>
      <p>You can clear these items at any time in your browser's settings; you'll be signed out.</p>
      <p className="small muted">Last updated {LEGAL_UPDATED}.</p>
    </>
  );
}

// ------------------------------------------------------------------ security

export function CertificationBadges({ list, compact }: { list: Certification[]; compact?: boolean }) {
  if (!list.length) return null;
  return (
    <div className={`cert-list${compact ? " compact" : ""}`}>
      {list.map((x) => (
        <div className="cert" key={`${x.scheme}-${x.certificate_number}`}>
          <span className="cert-mark" aria-hidden="true">✓</span>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="cert-title">{x.scheme} certified</div>
            <div className="xs muted">Certificate {x.certificate_number}{x.certification_body ? `, issued by ${x.certification_body}` : ""}, valid until {new Date(`${x.expires_on}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}</div>
          </div>
          {x.verify_url && <a className="btn sm" href={x.verify_url} target="_blank" rel="noreferrer">Verify</a>}
        </div>
      ))}
    </div>
  );
}

function Security({ c }: { c: Ctx }) {
  const n = c.brand.name;
  const contact = c.info.security_contact;
  return (
    <>
      <p className="lead">How we protect {n} and your data, and how to report a security problem.</p>
      <h2>Certification</h2>
      {c.certifications.length ? (
        <>
          <CertificationBadges list={c.certifications} />
          <p className="small muted">Cyber Essentials is the UK government-backed scheme, run by IASME for the National Cyber Security Centre, that certifies an organisation's protection against the most common cyber attacks. You can check a certificate on the IASME certificate search.</p>
        </>
      ) : (
        <p>{n} is built to support the five technical controls of the UK government's Cyber Essentials scheme: firewalls, secure configuration, user access control, malware protection and security update management. Certificates held by <V v={c.info.company_name} ph="Company legal name" /> are shown here while they are valid.</p>
      )}
      <h2>What we do</h2>
      <ul>
        <li><b>Encryption everywhere.</b> HTTPS only (TLS 1.2+, HSTS), including every connection to charge point operators; data encrypted at rest; operator credentials encrypted (AES-256-GCM) or stored only as hashes.</li>
        <li><b>Strong sign-in.</b> Passwords of at least 12 characters with common ones rejected, two-step verification with an authenticator app (fleets can require it; platform administrators must use it), and limits on password guessing.</li>
        <li><b>Least privilege.</b> Roles for each team member, isolation between fleets enforced in the application and again in the database, single-use invites that expire, and server-only secrets.</li>
        <li><b>Hardened web app.</b> A strict Content-Security-Policy with no third-party scripts, anti-framing headers, rate limits, size limits and validation on every request, and sanitised uploads.</li>
        <li><b>Audit trail.</b> Security-relevant actions (role changes, invitations, exports, deletions, policy changes) are logged; fleet owners can see their fleet's log.</li>
        <li><b>Secure development.</b> Automated tests, including security tests, and dependency vulnerability checks on every change; high and critical fixes within 14 days.</li>
        <li><b>Your control.</b> Export your fleet's data or delete your fleet and account yourself, at any time.</li>
      </ul>
      <h2>Report a vulnerability</h2>
      <p>
        If you think you've found a security problem, please tell us at {contact ? (contact.includes("@") ? <a href={`mailto:${contact}`}>{contact}</a> : <a href={contact} target="_blank" rel="noreferrer">{contact}</a>) : <V v="" ph="Security contact" />}
        {" "}with enough detail to reproduce it. Please don't access other people's data, disrupt the service or publish details before we've fixed it. We'll acknowledge your report within 3 working days, keep you updated, and won't take legal action against good-faith research that follows these rules.
        Our contact details are also published at <code>/.well-known/security.txt</code>.
      </p>
      <h2>Incidents</h2>
      <p>If an incident affects your data, we'll tell fleet owners without undue delay, and within 48 hours of becoming aware of a breach of their data, and work with you on what needs to happen next.</p>
    </>
  );
}

// ------------------------------------------------------------------ accessibility

function Accessibility({ c }: { c: Ctx }) {
  return (
    <>
      <p className="lead">We want everyone who plans or drives to be able to use {c.brand.name}, including people who use assistive technology.</p>
      <h2>What we aim for</h2>
      <p>We design to the Web Content Accessibility Guidelines (WCAG) 2.2 level AA: text and controls with sufficient contrast in light and dark themes, full keyboard use with visible focus, labelled form fields, text equivalents for charts, respect for reduced-motion settings, and layouts that work from small phones up, without horizontal scrolling.</p>
      <h2>Known limitations</h2>
      <ul>
        <li>The interactive map is easier with a mouse or touch; every site on it is also listed as text with the same information.</li>
        <li>The charging illustrations are decorative; each step is also described in words.</li>
      </ul>
      <h2>Feedback</h2>
      <p>If something is hard to use, or you need information in another format, contact <Mail v={c.info.contact_email} ph="Contact email" /> and we'll help, and fix what we can.</p>
      <p className="small muted">Last reviewed {LEGAL_UPDATED}.</p>
    </>
  );
}

// ------------------------------------------------------------------ licences

function Licences() {
  return (
    <>
      <p className="lead">This app includes the following open source software and data. We're grateful to their authors.</p>
      <table className="legal-table">
        <thead><tr><th>Component</th><th>Licence</th><th>Notice</th></tr></thead>
        <tbody>
          <tr><td>React, React DOM, Scheduler</td><td>MIT</td><td>Copyright (c) Meta Platforms, Inc. and affiliates.</td></tr>
          <tr><td>Lucide icons</td><td>ISC (some icons MIT, from Feather)</td><td>Copyright (c) Lucide Icons and Contributors; Copyright (c) 2013-present Cole Bemis (Feather).</td></tr>
          <tr><td>Archivo typeface</td><td>SIL Open Font License 1.1</td><td>Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo). Full licence: <a href="/fonts/OFL.txt" target="_blank" rel="noreferrer">/fonts/OFL.txt</a>.</td></tr>
          <tr><td>Natural Earth map data</td><td>Public domain</td><td>Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.</td></tr>
          <tr><td>OCPI 2.3.0 and the Bookings module</td><td>Specification</td><td>Open Charge Point Interface, published by the EVRoaming Foundation (evroaming.org). {""}This app implements the protocol; it does not include the specification text.</td></tr>
        </tbody>
      </table>
      <h2>MIT licence (React)</h2>
      <pre className="licence-text">{MIT}</pre>
      <h2>ISC licence (Lucide)</h2>
      <pre className="licence-text">{ISC}</pre>
    </>
  );
}

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const ISC = `Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`;
