// Settings → Webhooks: tell the fleet's own systems (TMS, dispatch, telematics) when a booking
// changes. Owners add an https address; each delivery is signed with a secret shown once.
import { useCallback, useEffect, useState } from "react";
import { WEBHOOK_EVENTS, type FleetWebhook, type WebhookEvent } from "../../shared/model";
import { useApp } from "../app/state";
import { ApiFailure } from "../app/backend";
import { fmtRelative } from "../app/format";
import { Field, Icon, Modal, Spinner, copyText } from "../ui/ui";

const EVENT_LABEL: Record<WebhookEvent, string> = {
  "booking.requested": "Booking requested",
  "booking.confirmed": "Booking confirmed",
  "booking.changed": "Time or bay changed",
  "booking.declined": "Booking or change declined",
  "booking.cancelled": "Booking cancelled",
  "booking.no_show": "Released as a no-show",
  "charging.started": "Charging started",
  "charging.completed": "Charging finished",
  "charge_record.received": "Charge record received",
};

export function WebhookSettings() {
  const { api, fleetId, toast, now } = useApp();
  const [hooks, setHooks] = useState<FleetWebhook[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!fleetId) return;
    setHooks(await api<FleetWebhook[]>("GET", `/fleets/${fleetId}/webhooks`));
  }, [api, fleetId]);
  useEffect(() => { void load().catch((e) => toast(e instanceof ApiFailure ? e.message : "Couldn't load webhooks", "bad")); }, [load, toast]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try { await fn(); await load(); } catch (e) { toast(e instanceof ApiFailure ? e.message : "That didn't work", "bad"); } finally { setBusy(null); }
  };
  const test = (h: FleetWebhook) => run(`t-${h.id}`, async () => {
    const r = await api<{ ok: boolean; status: number | null; error: string | null }>("POST", `/fleets/${fleetId}/webhooks/${h.id}/test`);
    toast(r.ok ? `Test delivered: HTTP ${r.status}` : `Test failed: ${r.error ?? "no answer"}`, r.ok ? "info" : "bad");
  });
  const toggle = (h: FleetWebhook) => run(`a-${h.id}`, () => api("PATCH", `/fleets/${fleetId}/webhooks/${h.id}`, { active: !h.active }));
  const remove = (h: FleetWebhook) => {
    if (confirming !== h.id) { setConfirming(h.id); return; }
    setConfirming(null);
    void run(`d-${h.id}`, () => api("DELETE", `/fleets/${fleetId}/webhooks/${h.id}`));
  };

  return (
    <section className="panel" id="s-webhooks">
      <div className="panel-head">
        <h2>Webhooks</h2>
        <button className="btn sm right" onClick={() => setAdding(true)} disabled={(hooks?.length ?? 0) >= 5}><Icon name="plus" size="sm" />Add webhook</button>
      </div>
      <div className="panel-body stack gap-12">
        <p className="small muted">Tell your own systems, such as a TMS or dispatch board, the moment a booking is confirmed, moved, cancelled or charged, so nobody has to watch this screen. Each delivery is a signed JSON POST (see docs/webhooks.md).</p>
      </div>
      {hooks === null ? (
        <div className="panel-body"><div className="skeleton" style={{ height: 40 }} /></div>
      ) : hooks.length === 0 ? null : (
        <ul className="list">
          {hooks.map((h) => {
            const failing = h.failures > 0;
            return (
              <li key={h.id} className="member-row webhook-row">
                <span className="avatar invite" aria-hidden="true"><Icon name="arrowUpRight" size="sm" /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 560 }}>{h.description || new URL(h.url).hostname}</div>
                  <div className="xs muted ellipsis" style={{ fontFamily: "var(--mono)" }} title={h.url}>{h.url}</div>
                  <div className="xs muted">
                    {h.events.length ? `${h.events.length} ${h.events.length === 1 ? "event" : "events"}` : "All events"} · secret <span style={{ fontFamily: "var(--mono)" }}>{h.secret_hint}</span>
                    {h.last_attempt_at ? ` · last delivery ${fmtRelative(h.last_attempt_at, now)}${h.last_status ? ` (HTTP ${h.last_status})` : ""}` : " · nothing sent yet"}
                  </div>
                  {failing && h.last_error && <div className="xs" style={{ color: "var(--bad)" }}>{h.active ? `Failing: ${h.last_error} (${h.failures} in a row)` : `Switched off after ${h.failures} failed deliveries: ${h.last_error}`}</div>}
                </div>
                <span className={`tag ${!h.active ? "" : failing ? "warn" : "ok"}`}>{!h.active ? "Off" : failing ? "Failing" : "On"}</span>
                <div className="row gap-4 webhook-actions">
                  <button className="btn sm ghost" disabled={busy !== null || !h.active} onClick={() => void test(h)}>{busy === `t-${h.id}` ? <Spinner /> : null}Send test</button>
                  <button className="btn sm ghost" disabled={busy !== null} onClick={() => void toggle(h)}>{h.active ? "Turn off" : "Turn on"}</button>
                  <button className={`btn sm ${confirming === h.id ? "danger" : "ghost"}`} disabled={busy !== null} onClick={() => remove(h)} onBlur={() => setConfirming((c) => (c === h.id ? null : c))}>{confirming === h.id ? "Confirm remove" : "Remove"}</button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {adding && <AddWebhookDialog onClose={() => setAdding(false)} onAdded={load} />}
    </section>
  );
}

function AddWebhookDialog({ onClose, onAdded }: { onClose(): void; onAdded(): Promise<void> }) {
  const { api, fleetId, toast } = useApp();
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [all, setAll] = useState(true);
  const [events, setEvents] = useState<WebhookEvent[]>(["booking.confirmed", "booking.changed", "booking.cancelled", "booking.declined"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<(FleetWebhook & { secret: string }) | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const h = await api<FleetWebhook & { secret: string }>("POST", `/fleets/${fleetId}/webhooks`, { url: url.trim(), description: description.trim(), events: all ? [] : events });
      setCreated(h);
      await onAdded();
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Couldn't add the webhook");
    } finally {
      setBusy(false);
    }
  };
  const flip = (e: WebhookEvent) => setEvents((xs) => (xs.includes(e) ? xs.filter((x) => x !== e) : [...xs, e]));

  return (
    <Modal
      title={created ? "Copy the signing secret" : "Add a webhook"}
      onClose={onClose}
      foot={created
        ? <button className="btn primary" onClick={onClose}>I've stored it safely</button>
        : <><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !url.trim() || (!all && events.length === 0)} onClick={add}>{busy && <Spinner />}Add webhook</button></>}
    >
      {created ? (
        <div className="stack gap-12">
          <p className="small"><b>This is the only time the secret is shown.</b> Your system uses it to check each delivery really came from us: the <code>Depotcharge-Signature</code> header carries an HMAC-SHA256 of the timestamp and body.</p>
          <div className="row gap-8">
            <input className="input" readOnly value={created.secret} onFocus={(e) => e.currentTarget.select()} aria-label="Signing secret" style={{ fontFamily: "var(--mono)", fontSize: 12 }} />
            <button className="btn" onClick={() => void copyText(created.secret).then((ok) => toast(ok ? "Secret copied" : "Couldn't copy the secret", ok ? "info" : "bad"))}><Icon name="copy" size="sm" />Copy</button>
          </div>
          <p className="xs muted">Use <b>Send test</b> to check your endpoint answers with a 2xx status. docs/webhooks.md has the payload and a verification example.</p>
        </div>
      ) : (
        <div className="stack gap-16">
          <Field label="Address" hint="An https address on the public internet that accepts POST requests.">
            {(id) => <input id={id} className="input" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tms.example.com/hooks/depotcharge" autoFocus />}
          </Field>
          <Field label="Name" hint="Optional, e.g. the system it feeds.">
            {(id) => <input id={id} className="input" value={description} maxLength={80} onChange={(e) => setDescription(e.target.value)} placeholder="Dispatch board" />}
          </Field>
          <fieldset className="field webhook-events">
            <legend className="label">Events</legend>
            <label className="check"><input type="radio" name="wh-all" checked={all} onChange={() => setAll(true)} /><span>Everything that happens to a booking</span></label>
            <label className="check"><input type="radio" name="wh-all" checked={!all} onChange={() => setAll(false)} /><span>Only these:</span></label>
            {!all && (
              <div className="webhook-event-grid">
                {WEBHOOK_EVENTS.map((e) => (
                  <label key={e} className="check"><input type="checkbox" checked={events.includes(e)} onChange={() => flip(e)} /><span>{EVENT_LABEL[e]}</span></label>
                ))}
              </div>
            )}
          </fieldset>
          {error && <div className="error-text" role="alert">{error}</div>}
        </div>
      )}
    </Modal>
  );
}
