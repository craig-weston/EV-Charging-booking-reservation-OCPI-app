# Testing with a real operator

The built-in simulator proves the booking flow end to end. Before real trucks depend on it, test
each operator's own OCPI 2.3.0 test system (their "sandbox" or "pre-production"). This guide
covers what to ask the operator for, a read-only check you can run first, and the test cases to
work through together.

## 1. Before you start

Ask the operator for:

- **The versions URL of their test system**, and a **registration token (token A)** for it.
- **The test sites** that publish BookingLocations, and which bays support Plug & Charge, MCS,
  and Autocharge (as the custom `AUTOCHARGE` connector capability, see
  [deploy.md](deploy.md#notes-on-the-ocpi-implementation)).
- **How their test chargers start sessions**: a real or simulated charger, and whether they can
  trigger a session, a CDR, a no-show or a cancellation on request.
- **A contact** for the test window, and their OCPI party ID (country code and party ID).

On your side, use a **staging deployment**: its own Cloudflare Worker and Supabase project, a
`PUBLIC_BASE_URL` the operator can reach, and `ENABLE_CPO_SIMULATOR` removed. Never point an
operator's test system at production. Give the operator your test party ID (`OCPI_PARTY_ID`).

## 2. Read-only check (before connecting)

From a clone of the repo, run:

```bash
OCPI_TOKEN=<their token A> npm run ocpi:probe -- https://ocpi-test.operator.example/versions --from GB:DPC
```

It only sends `GET` requests: it never registers, books or changes anything, and never prints
the token. It checks that:

- OCPI 2.3.0 is offered and its endpoints are listed, including `credentials`, `locations`,
  `tariffs` and the Bookings module (`bookings` SENDER);
- responses use the OCPI envelope, with `status_code` and `timestamp`.

With token A, the module pulls are usually refused (a registration token only opens versions
and credentials). That's expected. Once you're connected, an operator can give you a read token
for the probe, or you can rely on the app's own sync. With a token that opens the modules, the
probe also:

- pulls Locations, Tariffs and BookingLocations, and checks pagination headers;
- checks that every BookingLocation points to a Location you received and has calendars,
  booking terms and booking options;
- counts how many sites the sample trucks could book.

Example output against the simulator:

```text
versions
  ✔ OCPI 2.3.0 offered
endpoints
  ✔ credentials SENDER: …/2.3.0/credentials
  ✔ bookings SENDER: …/2.3.0/bookings
booking_locations
  ✔ 18 received

Bookable by sample trucks
  Tractor 01 (Volvo FH Electric): 17

OK: 8 passed, 0 warnings, 0 failures
```

Add `--json report.json` to save the result and send it to the operator.

## 3. Connect

In the staging app, a platform admin goes to **Network → Connect an operator**, enters the
versions URL and token A, and connects. If the operator prefers to register with you instead, use
**Invite an operator** and send them your versions URL and the token shown. After connecting,
check:

- **Network → Operators** shows the operator as connected, with the counts of Locations, Tariffs
  and BookingLocations it pulled.
- **Network → OCPI messages** shows the credentials handshake: `POST /credentials` answered with
  `status_code` 1000.

## 4. Test cases

Work through these with the operator on a call, and note the booking reference and time for
each. **Network → OCPI messages** shows every request and response, with credentials redacted.
Filter by module to find them, and send the operator the request IDs if anything fails.

| # | Case | Do | Expect |
| --- | --- | --- | --- |
| 1 | Booking confirmed | Book a slot for a Plug & Charge truck | `POST /bookings` with `request_id`, the plate as `LICENSE_PLATE` access info and token type `EMAID`; the booking turns **Reserved** (from the response or a pushed Booking) |
| 2 | Autocharge truck | Book for an Autocharge truck | Token type `OTHER` with the `VID:` vehicle ID; the operator's system accepts it |
| 3 | Bay assigned | Operator assigns a bay | Booking shows the bay (`evse_uid`) |
| 4 | Change accepted | Move the booking 30 minutes | Same `request_id`, new period; the operator accepts; the times update |
| 5 | Change refused | Ask for a time outside their calendar or terms | The operator rejects; the booking keeps its original time and says why |
| 6 | Cancel by fleet | Cancel with reason "Traffic" | Same `request_id` with `canceled` (`TRAFFIC`, `EMSP`); status **Cancelled** |
| 7 | Cancel by operator | Operator cancels (for example "Broken charger") | Pushed Booking with `canceled` (`CPO`); status **Cancelled**, reason shown; the driver is told if messages are on |
| 8 | Arrival and authorisation | Truck (or simulated charger) plugs in | `POST /tokens/{uid}/authorize` answered `ALLOWED` with the booking's `authorization_reference`; for unbooked trucks, per the fleet's setting |
| 9 | Session | Charging starts and runs | Sessions with the booking's `authorization_reference` link to it: live energy, power and battery level |
| 10 | Charge record | Session ends | The CDR's `booking_id` (or `authorization_reference`) links it; totals appear on the booking |
| 11 | No-show | Don't turn up | Operator sets **No-show**; status changes; any no-show fee is shown from the tariff |
| 12 | Calendars update | Operator changes availability | A Calendar or BookingLocation push updates the slots offered |
| 13 | Out-of-order push | Operator pushes an older Booking after a newer one | The older one is ignored (`last_updated` wins); a final status never goes back |
| 14 | Credentials update | Operator rotates its token (`PUT /credentials`) | Connection stays up; the next requests use the new token |
| 15 | Wrong token | Operator calls with an old token | `401`; repeated failures are rate limited |

For each case, record the outcome as a pass, or a fail with the request ID and what went wrong.

## 5. Before going live

- **All cases pass**, or any differences are agreed and written down: for example, an operator
  that doesn't push Booking updates and only answers in the `POST` response.
- **Production connection:** the operator gives you a token A for production. Connect it from
  the production app, run the probe once more against their production versions URL, and make
  one real booking with a test truck.
- **Agreements:** the commercial and data protection terms with the operator are signed, and
  they are listed as a recipient in your records (see
  [compliance/data-protection.md](compliance/data-protection.md)).
