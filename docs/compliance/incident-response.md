# Incident response plan

For anything that threatens the confidentiality, integrity or availability of Depotcharge or the
data in it: a compromised account, a leaked key, data seen by the wrong people, a malicious
dependency, an outage caused by an attack. If in doubt, treat it as an incident and report it.

## Roles

| Role | Who | Does |
| --- | --- | --- |
| Incident lead | [Security lead], deputy [Name] | Runs the response, decides on containment, keeps the log |
| Director | [Director responsible] | Decides on notifications, customer communication and outside help |
| Technical responder | [Name] | Investigates and fixes: Cloudflare, Supabase, GitHub, the code |
| Communications | [Name] | Customer and operator messages, the status update |

Contacts (keep current): incident lead [phone], director [phone], cyber insurer's 24/7 line
[number], solicitor [name, phone].

## Severity

- **S1 – critical:** personal data exposed or likely exposed; production keys leaked; attacker
  activity in progress; service down because of an attack. Act now, around the clock.
- **S2 – high:** a single account compromised; a vulnerability that's exploitable but not
  known to be exploited; an operator's credentials possibly exposed. Same working day.
- **S3 – low:** a blocked attack, a suspicious email reported, a minor misconfiguration.
  Within 3 working days.

## The first hour

1. **Write it down.** Start an incident log (time, who, what was seen, what was done). Don't
   delete anything that may be evidence.
2. **Assess** what is affected: which fleets, which data, which operators, since when.
   Depotcharge's audit log (Compliance → Platform activity log; each fleet's Settings → Security),
   the OCPI message log, Cloudflare analytics and logs, and Supabase Auth and API logs help.
3. **Contain** using the playbooks below. Prefer revoking access over shutting everything down.
4. **Escalate** S1 and S2 to the director immediately. Decide whether outside help is needed
   (insurer's response team, NCSC-assured incident response provider).
5. **Start the clock** for notifications: the ICO deadline is 72 hours from when we became
   aware of a personal data breach.

## Playbooks

**A person's account is compromised.** Remove them from their fleets in Depotcharge (Settings →
Team), which cuts off API access at once because membership is checked on every request. In
Supabase → Authentication → Users, ban the user (this blocks sign-in and session refresh) until
they've reset their password; a platform admin resets their two-step verification only after
verifying who they are. Review the fleet's activity log for what the account did, especially
exports (`fleet.export`), invites created and role changes, then re-add them.

**`SUPABASE_SERVICE_ROLE_KEY` leaked.** Supabase → Project Settings → API keys: create a new
secret key and revoke the old one (or roll the legacy JWT secret, which also signs everyone out);
update the Cloudflare environment variable and redeploy; review Supabase API logs for use of the
old key; treat the database as exposed until shown otherwise.

**`DATA_ENCRYPTION_KEY` leaked.** Rotate it as in the security policy (section 8), then ask every
connected operator to issue new credentials (re-registration), because their tokens may be
decryptable by whoever has the old key and a database copy.

**An operator's OCPI credentials exposed** (in either direction). Network → the operator →
disconnect, or issue a new registration token and ask them to register again; tell the
operator's technical contact so they rotate the token they issued to us.

**Driver pass link shared too widely.** In the booking, choose **Reset link** under the driver
pass: the old link stops working at once and a new one is issued. Pass links also expire on their
own 7 days after the slot (2 days after a cancellation).

**Malicious or vulnerable dependency.** Pin to a known-good version (`package-lock.json`),
redeploy, check the build logs and the deployed bundle for unexpected code or network calls, and
rotate any secret the build could have read.

**Denial of service or abusive traffic.** Cloudflare → Security: turn on "Under Attack" mode for
the static app only (not `/ocpi/*`, which operators' servers call), add rate-limiting or block
rules for the offending addresses or patterns.

## Telling people

**Personal data breach** (a security incident that leads to accidental or unlawful destruction,
loss, alteration, unauthorised disclosure of, or access to, personal data):

| Who | When | How |
| --- | --- | --- |
| Customers (fleet operators) whose data is affected: they are the controllers | Without undue delay, and within 48 hours of becoming aware (our data processing terms) | Email to fleet owners: what happened, what data, what we've done, what they should do, contact |
| The ICO, for breaches of data we control (our users' accounts, security logs) | Within 72 hours of becoming aware, unless the breach is unlikely to result in a risk to people | ico.org.uk/for-organisations/report-a-breach, or 0303 123 1113 |
| Affected individuals | Without undue delay when the breach is likely to result in a high risk to them | Directly, in plain language; for fleet data, agree this with the customer |
| Charge point operators | When their credentials or systems are involved | Their technical contact |

**Crime and national reporting:** report cyber crime and fraud to Report Fraud (formerly Action
Fraud) at reportfraud.police.uk or 0300 123 2040 (England, Wales and Northern Ireland; in Scotland,
Police Scotland on 101). Significant incidents can be reported to the NCSC at report.ncsc.gov.uk.

**Insurer:** tell the cyber insurer as its policy requires, often before engaging outside help.

## Breach and incident log

Record **every** personal data breach, including those not reported to the ICO, with the facts,
the effects and what was done (UK GDPR Article 33(5)).

| Date found | What happened | Data and people affected | Risk assessment | Reported to ICO? (date, reference) | Customers / individuals told? | Actions | Closed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | |

## After the incident

Within two weeks of closing an S1 or S2 incident, hold a blameless review: timeline, root cause,
what worked, what didn't, and actions with owners and dates. Update this plan, the security policy
and the Compliance checklist if needed. Rehearse this plan with a short tabletop exercise once a
year (the NCSC's free "Exercise in a Box" works well).
