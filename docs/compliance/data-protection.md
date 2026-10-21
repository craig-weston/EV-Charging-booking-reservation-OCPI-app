# Data protection records

UK GDPR and the Data Protection Act 2018, as amended by the Data (Use and Access) Act 2025, require
us to know what personal data we hold and why, keep it no longer than needed, protect it, and help
people use their rights. These records are the evidence. Keep them in step with the privacy notice
and data processing terms in the app (`src/legal/documents.tsx`).

## 1. Who is responsible for what

| Data | Our role | Notes |
| --- | --- | --- |
| Accounts of people who sign in (email, password hash held by Supabase Auth, two-step verification, roles) | **Controller** | |
| Security records (audit log, IP addresses, sign-in logs) | **Controller** | |
| Business contacts, contracts, invoices | **Controller** | |
| Fleet data: vehicles and plates, charging IDs, drivers' names and phones, bookings, sessions, charge records, notes | **Processor** for the fleet operator (our customer) | Under the data processing terms (Article 28) |
| Booking details sent to a charge point operator (time, plate, charging ID) | Disclosed on the customer's instruction | The operator is an **independent controller** |

## 2. Record of processing activities (Article 30)

### As controller

| Purpose | Data subjects | Personal data | Lawful basis | Recipients | Transfers outside the UK | Retention |
| --- | --- | --- | --- | --- | --- | --- |
| Providing accounts and sign-in | Customers' staff | Work email, password hash, MFA factors, roles, fleet memberships | Legitimate interests (providing the service the customer contracted) | Supabase (processor) | Supabase support may access from the USA; safeguards below | Until the account is deleted |
| Keeping the service secure | Users | IP address, audit log entries (who did what, when) | Legitimate interests (security) | Cloudflare, Supabase (processors) | As above | Audit log 12 months; OCPI log 30 days |
| Customer relationship and billing | Customers' contacts | Name, work email, phone, invoices | Contract; legal obligation (accounting) | Accountant, bank | [None] | 6 years after the financial year |
| Handling privacy requests and complaints | Requesters | Correspondence | Legal obligation | [None] | [None] | 2 years after closing |

### As processor (for each customer)

| Categories of processing | Data subjects | Personal data | Sub-processors | Transfers | Security |
| --- | --- | --- | --- | --- | --- |
| Storing and organising fleet data; sending booking details to operators; receiving sessions and charge records; showing driver passes | Customers' drivers and staff | Driver name and phone; plates; charging IDs (contract or vehicle IDs); booking times and places; charging data (energy, battery level, costs); notes | Cloudflare, Supabase, [email provider] | See section 5 | See the data processing terms, Annex B |

## 3. Retention schedule

| Data | Kept for | How it's deleted |
| --- | --- | --- |
| User account | Until the person deletes it (Settings → Security) or the customer removes them | Account deletion removes the Supabase Auth user; audit entries keep the action but drop the email |
| Fleet data | While the customer uses the service | Fleet deletion (owner, Settings → Security) removes team, invites, vehicles, drivers, bookings and history |
| Bookings, sessions, charge records | 6 years after the booking (accounting and disputes) | `depotcharge_retention()` daily (pg_cron) |
| OCPI message log | 30 days | `depotcharge_retention()` |
| Audit log | 12 months | `depotcharge_retention()` |
| Used or expired invites | 30 days | `depotcharge_retention()` |
| Driver pass links | Stop working 7 days after the slot (2 days after a cancellation), or when reset | Enforced on every lookup |
| Backups | Up to 30 days (Supabase's backup window on your plan) | Overwritten by the provider |

Check that pg_cron is enabled and the job exists:
`select * from cron.job where jobname = 'depotcharge-retention';`

## 4. Data protection impact assessment (DPIA)

**Screening.** The service processes data about employees (drivers) that reveals where and when
they will be (booking times at named sites), on behalf of their employers, using vehicle
identifiers recognised by site cameras and chargers. It doesn't track vehicles continuously and
holds no special category data. Because it combines location-related data with employee
monitoring potential and number plate recognition at sites, we carry out a DPIA as good practice.

**Description.** Planners book charging slots; booking details go to the chosen operator over
OCPI; the operator's barrier recognises the plate and its charger recognises the vehicle (Plug &
Charge contract ID or Autocharge vehicle ID); session and charge data come back. Drivers get a pass
link showing their booking.

**Necessity and proportionality.** Plates and charging IDs are needed for gate access and to
start charging without cards; booking times are the service itself. We collect drivers' names and
phone numbers only to help planners contact and brief drivers; both are optional. Data is kept
only as long as section 3 sets out. Operators receive only what they need for a booking, and the
OCPI token list carries no plates or names.

| Risk to individuals | Likelihood / severity | Mitigation | Residual |
| --- | --- | --- | --- |
| Booking history used to monitor drivers beyond its purpose | Possible / moderate | Customer is the controller and decides use; terms require lawful use and informing drivers; retention limits | Low |
| Another customer or an outsider reads fleet data | Remote / significant | Tenant checks on every API route, row level security, MFA, rate limits, encryption in transit and at rest, audit log | Low |
| A pass link reaches the wrong person, revealing a driver's name, plate and location | Possible / minimal | Random 24-byte links, expiry, revocation, only first-name level detail needed | Low |
| An operator uses booking data for other purposes | Remote / moderate | Data minimised; operators are independent controllers bound by law and their agreements | Low |
| Data kept longer than needed | Possible / minimal | Automated retention job, deletion tools | Low |

**Outcome.** Residual risk is low; no prior consultation with the ICO is needed. Review this DPIA
when processing changes (for example adding live vehicle tracking, telematics or analytics).
Signed off: [Name, role, date].

## 5. International transfers

| Supplier | Where data goes | Safeguard |
| --- | --- | --- |
| Supabase | Database in [London, UK (AWS eu-west-2)]; support access from outside the UK | Supabase's data processing addendum with Standard Contractual Clauses; check it includes the UK Addendum or IDTA, or rely on the UK Extension to the EU–US Data Privacy Framework if Supabase is certified |
| Cloudflare | Global network, including the USA | Cloudflare's data processing addendum (with the UK Addendum or IDTA), or the UK Extension to the EU–US Data Privacy Framework (check Cloudflare's current certification on dataprivacyframework.gov) |
| [Email provider] | [Region] | [Safeguard] |

Record a transfer risk assessment for each restricted transfer (the ICO's TRA tool is suitable).

## 6. Sub-processors

The current list is in the app's data processing terms (Annex C). To add or change one: check its
security and terms, sign its DPA, update Annex C in `src/legal/documents.tsx` and this file, and
email fleet owners **at least 30 days before** it starts processing customer data.

## 7. Requests from individuals

- **Access, correction, deletion, restriction, objection, portability.** Reply within one month
  (extendable by two months for complex requests, telling the person within the first month).
  Under the Data (Use and Access) Act 2025, searches need only be reasonable and proportionate,
  and the clock pauses while you ask for information you genuinely need to answer (requests
  received from 5 February 2026).
- **Check identity** proportionately, without asking for more than needed.
- **Fleet data:** we're the processor, so pass the request to the customer within 5 working
  days and help them answer it. Owners can export everything (Settings → Security → Export fleet
  data) and delete drivers, vehicles or the whole fleet themselves.
- **Account data:** people can delete their own account; for copies of their data, export it
  from the database for that user ID (memberships, audit entries) and send it securely.
- **Complaints** (Data Protection Act 2018 section 164A, in force since 19 June 2026): complaints
  can be made by email to the privacy address; acknowledge within 30 days, investigate without
  undue delay, and tell the person the outcome. Keep a log of complaints.

## 8. Cookies and similar technologies (PECR)

The app stores only what's strictly necessary or remembers a choice the user made (sign-in session,
pending invite, chosen fleet, theme, dismissed alerts, demo data), listed on the Cookies and storage
page. It loads no third-party content, so no consent banner is needed. If analytics are ever added,
reassess first: the Data (Use and Access) Act exemption for statistical purposes still requires
clear information and a simple way to object.
