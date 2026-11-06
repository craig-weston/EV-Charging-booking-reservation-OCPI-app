# Sending the plan to the chargers

Depot smart charging works out each charger's power for every half-hour. This page covers how that
plan reaches the chargers and what they report back.

## How it works

1. **Sending.** Every charger with a truck in the plan gets an OCPP charging profile: a
   `SetChargingProfile` request with a `TxDefaultProfile` in watts. Each new plan replaces the last
   one.
2. **Answering.** Each charger accepts or refuses its plan.
3. **Reporting.** Chargers report their state: free, truck plugged in, charging, fault, or out of
   service.
4. **Planning around faults.** If a charger reports a fault or is taken out of service, the plan
   gives it nothing until it reports that it's working again. The page then names the truck that
   can't charge there and offers to move it to a working charger that's free for its whole stay.
   Moving it sends the new plan straight away.
5. **Losing contact.** If the connection drops, a charger carries on with the last plan it accepted,
   then falls back to its own settings.

On the Depot page, the **Chargers** row lists every charger with what it last reported and its
answer to the latest plan. A fault, or a refused plan, shows in red. After you send a plan, the page
checks for answers every 2 seconds for a short while. After that it checks every 30 seconds while
the chargers are connected.

## Choosing how the chargers are reached

Choose under **Depot settings → Connect the chargers**:

| Choice | What happens |
|---|---|
| **Not yet** | The plan is worked out, and nothing is sent. |
| **Simulated** | Simulated OCPP chargers check each plan the way a real charger would, and answer. Nothing leaves the app. You can choose a charger to develop a fault a few seconds after it gets a plan, to see what happens. |
| **CitrineOS** | The plan goes through CitrineOS, a free, open-source charger management system. Answers and faults come back within seconds. |
| **Operator's system** | For a depot run by a charge point operator: each charger's request is posted to their system, signed. They can report answers and faults back. |

The demo uses simulated chargers. Send the plan to the chargers, and Bay 3 develops a fault
(earth leakage) six seconds later. Tanker 05 is shown as unable to charge there, and **Move to
Bay 5** moves it to the spare bay and sends the new plan.

## CitrineOS

### What gets sent and set up

For each charger, Depotcharge sends:

```http
POST {CitrineOS address}/ocpp/{version}/smartcharging/setChargingProfile?identifier={station id}&tenantId={tenant}&callbackUrl={answer address}
```

The details:

- **Version:** 2.0.1, or 2.1 if you choose it in the settings. Plans where a truck gives power back
  always use 2.1.
- **Token:** if you set an API token, it's sent as a Bearer token.
- **Answers:** CitrineOS passes the charger's answer (`{ "status": "Accepted" }`, or `Rejected`
  with a reason) to the callback address.
- **Subscriptions:** the first time a plan goes to a station, Depotcharge asks CitrineOS to forward
  that station's `StatusNotification` and `NotifyEvent` messages, plus its connects and disconnects.
  It uses `POST {address}/ocpprouter/subscription`, or `/data/ocpprouter/subscription` on
  CitrineOS 1.x. These messages go to the depot's report address.
- **Report address:** both the callback and report addresses contain a secret token unique to the
  depot. It's created the first time a plan is sent and stored encrypted.

What CitrineOS needs:

- Its API must have an https address that can be reached from the internet.
- It must be able to reach your Depotcharge address, to post answers and status messages back.

### Try it free on your own computer

You'll need Docker, Node.js with pnpm, and Cloudflare's `cloudflared`. All are free.

1. Get CitrineOS:

   ```sh
   git clone https://github.com/citrineos/citrineos-core
   cd citrineos-core
   pnpm install
   ```

2. Start it with EVerest's simulated charger:

   ```sh
   pnpm citrine --everest
   ```

   That starts:

   | What | Where |
   |---|---|
   | The CitrineOS API (docs at `/docs`) | `http://localhost:8080` |
   | Charger connections | `ws://localhost:8081` |
   | The operator screens | `http://localhost:3000` |
   | EVerest's simulated charger (station `cp001`) | — |
   | EVerest's screen (plug a car in, unplug it and more) | `http://localhost:1880/ui` |
   | EVerest's OCPP log | `http://localhost:8888` |

3. Give the CitrineOS API a public https address with a free quick tunnel (no account needed):

   ```sh
   cloudflared tunnel --url http://localhost:8080
   ```

   It prints an address such as `https://something.trycloudflare.com`. The address changes each
   time you run it.

4. In Depotcharge, open **Depot settings**:
   - Under **Chargers**, give one charger the station id `cp001` and EVSE id 1.
   - Under **Connect the chargers**, choose **CitrineOS**. Enter the tunnel address and tenant id
     `1`, and choose OCPP version **2.1**: EVerest started this way uses OCPP 2.1.

5. Add a truck to that charger, then choose **Send the plan to the chargers**.
   - EVerest's OCPP log shows the `SetChargingProfile` arriving.
   - The Chargers row shows the charger's answer.

6. To see the connection drop, stop EVerest with `docker stop everest-manager-1`. CitrineOS reports
   the disconnect, and the charger shows as having lost contact. Faults a charger reports (a
   `StatusNotification` of `Faulted`, or a `NotifyEvent` problem) show in red and are planned
   around.

## A depot operator's own system

Each charger's request is posted to their address and signed with `Depotcharge-Signature`, the same
scheme as fleet webhooks (`docs/webhooks.md`). The request looks like this:

```json
{
  "type": "ocpp.set_charging_profile",
  "station_id": "YARD-CP03", "depot_id": "…", "charger_id": "bay-3",
  "sent_at": "2026-11-06T18:05:00Z",
  "request": { "evseId": 1, "chargingProfile": { … } },
  "answer_url": "https://…/api/chargers/…?charger=bay-3&sent=…",
  "report_url": "https://…/api/chargers/…"
}
```

Their system can report back to two addresses:

- **The charger's answer** goes to `answer_url`: `{ "status": "Accepted" }`, or
  `{ "status": "Rejected", "statusInfo": { "reasonCode": "…" } }`.
- **Station messages** go to `report_url`, in CitrineOS's subscription format:
  `{ "stationId": "YARD-CP03", "event": "message", "message": [2, "id", "StatusNotification", { … }] }`.
  Connects and disconnects use `"event": "connected"` and `"event": "closed"`.

Station messages that are understood:

- `StatusNotification` from OCPP 2.0.1, 2.1 or 1.6. OCPP 1.6 error codes are shown in plain words.
- `NotifyEvent`: the `Problem` and `AvailabilityState` variables.

Anything else is accepted and ignored.
