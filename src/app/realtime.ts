// Live updates in live mode: Supabase Realtime tells the browser the moment a booking in this
// fleet changes (an operator confirms, a session starts, a charge record arrives), and the app
// then reloads through its own API. Row level security decides what each person is told about.
//
// A small Phoenix-channel client over the browser's WebSocket, so there's no extra dependency.
// If the socket can't connect, the app keeps polling as before.

export interface RealtimeOptions {
  supabaseUrl: string;
  anonKey: string;
  fleetId: string;
  /** Current access token (refreshed by the auth client). */
  token(): Promise<string | null>;
  onChange(): void;
  /** Connected (true) or lost (false): the app polls faster while disconnected. */
  onStatus?(connected: boolean): void;
  WebSocketImpl?: typeof WebSocket;
}

const HEARTBEAT_MS = 25_000;
const TOKEN_CHECK_MS = 60_000;

export function realtimeUrl(supabaseUrl: string, anonKey: string): string {
  return `${supabaseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(anonKey)}&vsn=1.0.0`;
}

export function joinMessage(fleetId: string, accessToken: string, ref: string) {
  const filter = `fleet_id=eq.${fleetId}`;
  return {
    topic: `realtime:fleet-${fleetId}`,
    event: "phx_join",
    ref,
    join_ref: ref,
    payload: {
      config: {
        broadcast: { self: false },
        presence: { key: "" },
        postgres_changes: [
          { event: "*", schema: "public", table: "bookings", filter },
          { event: "INSERT", schema: "public", table: "booking_events", filter },
        ],
      },
      access_token: accessToken,
    },
  };
}

/** Starts the subscription; returns a function that stops it. */
export function subscribeFleet(o: RealtimeOptions): () => void {
  const WS = o.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : undefined);
  if (!WS) return () => undefined;
  let ws: WebSocket | null = null;
  let stopped = false;
  let ref = 0;
  let joinRef = "";
  let lastToken = "";
  let backoff = 1000;
  let timers: ReturnType<typeof setInterval>[] = [];
  let retry: ReturnType<typeof setTimeout> | null = null;
  const topic = `realtime:fleet-${o.fleetId}`;
  const send = (m: unknown) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };

  const cleanup = () => {
    for (const t of timers) clearInterval(t);
    timers = [];
  };

  const connect = async () => {
    if (stopped) return;
    const token = await o.token().catch(() => null);
    if (!token || stopped) { schedule(); return; }
    lastToken = token;
    try {
      ws = new WS(realtimeUrl(o.supabaseUrl, o.anonKey));
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      joinRef = String(++ref);
      send(joinMessage(o.fleetId, token, joinRef));
      timers.push(setInterval(() => send({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(++ref) }), HEARTBEAT_MS));
      // Keep the channel's token fresh, or Realtime closes it when the old one expires.
      timers.push(setInterval(async () => {
        const t = await o.token().catch(() => null);
        if (t && t !== lastToken) { lastToken = t; send({ topic, event: "access_token", payload: { access_token: t }, ref: String(++ref), join_ref: joinRef }); }
      }, TOKEN_CHECK_MS));
    };
    ws.onmessage = (ev) => {
      let m: { topic?: string; event?: string; payload?: { status?: string } } = {};
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.topic !== topic) return;
      if (m.event === "phx_reply" && m.payload?.status === "ok") { backoff = 1000; o.onStatus?.(true); }
      else if (m.event === "phx_reply" && m.payload?.status === "error") ws?.close();
      else if (m.event === "postgres_changes") o.onChange();
      else if (m.event === "phx_error" || m.event === "phx_close" || m.event === "system" && (m.payload as { status?: string })?.status === "error") ws?.close();
    };
    ws.onclose = () => {
      cleanup();
      o.onStatus?.(false);
      schedule();
    };
    ws.onerror = () => ws?.close();
  };

  function schedule() {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; void connect(); }, backoff);
    backoff = Math.min(backoff * 2, 60_000);
  }

  void connect();
  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    cleanup();
    if (ws) { ws.onclose = null; ws.close(); }
  };
}
