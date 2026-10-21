# Launch checklist: legal and compliance

Work through this before the first real customer. It isn't legal advice: have a solicitor
review the contracts and anything marked ⚖️.

## Your company and website

- [ ] **Company details on the site.** In the app: Compliance → Company & legal. The Companies Act
      trading disclosure rules and the Electronic Commerce Regulations 2002 require your registered
      name, company number, place of registration, registered office address and a contact email
      on your website (VAT number if registered). The legal pages and footers use these.
- [ ] **Brand check.** Search the UK Intellectual Property Office trade mark register (and
      Companies House) for "Depotcharge" and any white-label names before you invest in them;
      consider registering the mark in class 9 (software) and class 39 or 42 (services). ⚖️
- [ ] **Domain** registered to the company, with MFA on the registrar account.

## Data protection

- [ ] **Pay the ICO data protection fee** (tier 1 for micro organisations is £52 a year, £47 by
      direct debit; check the ICO's current fees) and enter the registration number in Company &
      legal.
- [ ] **Data processing terms signed with suppliers:** Cloudflare (accepted in the dashboard),
      Supabase (its DPA, from the dashboard or legal hub), and your email delivery provider.
- [ ] **Supabase region** chosen in the UK (London) or EU, and entered as the database region.
- [ ] **Records:** the record of processing, retention schedule and DPIA in
      [data-protection.md](data-protection.md) completed and signed off.
- [ ] **Privacy contact** that is actually monitored (privacy email in Company & legal), and a
      complaints process (required since 19 June 2026), with a simple log of complaints.
- [ ] **Retention job** scheduled: pg_cron enabled and `depotcharge-retention` listed in
      `cron.job`.

## Contracts ⚖️

- [ ] **Terms of service, data processing terms and privacy notice** (`/#/legal/…`) reviewed by
      a solicitor and adjusted to your commercial model; liability caps checked for
      reasonableness under the Unfair Contract Terms Act 1977.
- [ ] **Order form** template (plan, fees, service level, support hours, notice periods).
- [ ] **Agreements with each charge point operator** before connecting them over OCPI: which
      roles and modules, how booking, no-show and charging fees are settled and invoiced, service
      levels, data sharing (each side an independent controller), security contacts and incident
      notification, liability.
- [ ] **How money flows.** If you buy charging from operators and resell it to fleets, you act
      as principal. If you collect fleets' money on operators' behalf, that can be a regulated
      payment service under the Payment Services Regulations 2017 unless an exclusion applies.
      Take advice before you take payments. ⚖️
- [ ] **Business customers only.** The terms say the service isn't for consumers. If you sign up
      sole traders, consumer protection rules may apply to them. ⚖️

## Security and Cyber Essentials

- [ ] Every item in the app's **Compliance** page done, with evidence noted.
- [ ] Production environment variables set: `DATA_ENCRYPTION_KEY`, `SECURITY_CONTACT`,
      `PUBLIC_BASE_URL`; `ENABLE_CPO_SIMULATOR` removed; `REQUIRE_ADMIN_MFA` not set to false.
- [ ] `https://<your-domain>/.well-known/security.txt` loads and shows your contact.
- [ ] `package-lock.json` committed, CI green, Dependabot on, branch protection on `main`.
- [ ] Independent penetration test done and high and critical findings fixed.
- [ ] Cyber Essentials self-assessment submitted to an IASME certification body, and the
      certificate entered in Compliance → Certificates when issued
      ([cyber-essentials.md](cyber-essentials.md)).

## Accessibility

- [ ] Keyboard-only and screen reader check of sign-in, booking, the driver pass and settings
      against WCAG 2.2 AA; fix issues and keep the accessibility statement accurate. The Equality
      Act 2010 duty to make reasonable adjustments applies to services you provide.

## Charging regulations

- [ ] The **Public Charge Point Regulations 2023** place duties on operators of public charge
      points (for example contactless payment, pricing in pence per kWh, reliability of rapid
      chargers, open data and a free 24/7 helpline). They fall on the operators you book with,
      not on Depotcharge as a booking platform, but check whether a partner's depot bays count as
      public and show prices clearly in pence per kWh. ⚖️

## Insurance

- [ ] Cyber insurance (incident response cover and a 24/7 line), professional indemnity and
      public liability, with limits that match your contracts.
