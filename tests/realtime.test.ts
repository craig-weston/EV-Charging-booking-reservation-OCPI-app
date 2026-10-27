// Live updates client (src/app/realtime.ts) against a fake Supabase Realtime socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import { joinMessage, realtimeUrl, subscribeFleet } from "../src/app/realtime";

class FakeSocket {
  static last: FakeSocket | null = null;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: { topic: string; event: string; payload: Record<string, unknown>; ref: string }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeSocket.last = this; FakeSocket.all.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("realtime: URL, join filter and token", () => {
  assert.equal(realtimeUrl("https://abc.supabase.co/", "anon key"), "wss://abc.supabase.co/realtime/v1/websocket?apikey=anon%20key&vsn=1.0.0");
  const j = joinMessage("f-1", "jwt", "1");
  assert.equal(j.topic, "realtime:fleet-f-1");
  assert.equal(j.payload.access_token, "jwt");
  assert.deepEqual(j.payload.config.postgres_changes.map((c) => `${c.table}:${c.event}:${c.filter}`), ["bookings:*:fleet_id=eq.f-1", "booking_events:INSERT:fleet_id=eq.f-1"]);
});

test("realtime: joins, reports status, signals changes, reconnects, stops cleanly", async () => {
  FakeSocket.all = [];
  let changes = 0;
  const status: boolean[] = [];
  const stop = subscribeFleet({
    supabaseUrl: "https://abc.supabase.co", anonKey: "anon", fleetId: "f-1", token: async () => "jwt-1",
    onChange: () => changes++, onStatus: (c) => status.push(c), WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
  });
  await tick();
  const ws = FakeSocket.last!;
  assert.equal(ws.sent[0].event, "phx_join");
  assert.equal(ws.sent[0].payload.access_token, "jwt-1");
  ws.receive({ topic: "realtime:fleet-f-1", event: "phx_reply", payload: { status: "ok" }, ref: "1" });
  assert.deepEqual(status, [true]);
  ws.receive({ topic: "realtime:fleet-f-1", event: "postgres_changes", payload: { data: { table: "bookings" } } });
  ws.receive({ topic: "realtime:fleet-other", event: "postgres_changes", payload: {} });
  ws.receive("not json");
  assert.equal(changes, 1, "only this fleet's channel counts");

  // Server closes the socket: status goes false and it reconnects after a back-off.
  ws.close();
  assert.deepEqual(status, [true, false]);
  await tick(1100);
  assert.equal(FakeSocket.all.length, 2, "reconnected");
  stop();
  const n = FakeSocket.all.length;
  await tick(1100);
  assert.equal(FakeSocket.all.length, n, "no reconnect after stop");
});

test("realtime: no token yet → waits instead of connecting", async () => {
  FakeSocket.all = [];
  const stop = subscribeFleet({ supabaseUrl: "https://abc.supabase.co", anonKey: "anon", fleetId: "f", token: async () => null, onChange: () => undefined, WebSocketImpl: FakeSocket as unknown as typeof WebSocket });
  await tick(20);
  assert.equal(FakeSocket.all.length, 0);
  stop();
});
