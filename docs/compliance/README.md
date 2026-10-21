# Compliance pack

Security, Cyber Essentials and data protection records for the organisation that runs
Depotcharge. They are templates written for this codebase and its hosting (Cloudflare Pages and
Supabase). Fill in the bracketed parts, adapt them to how your organisation really works, and have
the legal documents reviewed by a solicitor before launch.

| Document | What it's for |
| --- | --- |
| [Cyber Essentials readiness](cyber-essentials.md) | What gets certified, the scope, each control mapped to the app, hosting and your own devices, and the steps to certification |
| [Information security policy](security-policy.md) | The rules your people follow: accounts, devices, networks, cloud services, updates, secrets, backups |
| [Incident response plan](incident-response.md) | What to do in the first hour, playbooks (leaked keys, compromised accounts), who to tell and when |
| [Secure development](secure-development.md) | How the software is built and changed, mapped to the UK Software Security Code of Practice |
| [Data protection records](data-protection.md) | Record of processing, retention schedule, DPIA, rights requests, transfers, sub-processors |
| [Launch checklist](launch-checklist.md) | Legal and compliance tasks to finish before the first real customer |

The in-app side of this lives in **Compliance** (platform admins): automatic checks of the live
configuration, a checklist you tick with evidence, company details for the legal pages, and your
certificates. The customer-facing documents (privacy notice, terms, data processing terms, cookies,
security, accessibility, licences) are in the app at `/#/legal/…`, generated from
`src/legal/documents.tsx`.

## Ownership and review

| | |
| --- | --- |
| Owner | [Name, role] |
| Director responsible | [Name] (signs the Cyber Essentials declaration) |
| Review | At least every 12 months, before each Cyber Essentials renewal, and after any significant change or incident |

| Version | Date | Change | By |
| --- | --- | --- | --- |
| 1.0 | 21 October 2026 | First version | [Name] |
