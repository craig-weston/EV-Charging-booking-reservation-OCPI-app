// Driver pass and invite tokens are sealed at rest and found by their SHA-256 (Supabase store).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookingRow, FleetInvite } from "../shared/model";
import { SupabaseStore } from "../server/store/supabase";
import { sha256Hex } from "../server/security";

/** Just enough PostgREST: rows per table, `col=eq.value` filters, limit/offset, insert/update/select. */
function fakePostgrest() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const queries: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const table = url.pathname.split("/").pop()!;
    const rows = tables.get(table) ?? [];
    tables.set(table, rows);
    queries.push(`${init?.method ?? "GET"} ${table}?${url.searchParams.toString()}`);
    const filters = [...url.searchParams].filter(([, v]) => v.startsWith("eq."));
    const match = (r: Record<string, unknown>) => filters.every(([k, v]) => String(r[k]) === v.slice(3));
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const list = [].concat(JSON.parse(String(init!.body)));
      rows.push(...list);
      return Response.json(list);
    }
    if (method === "PATCH") {
      const patch = JSON.parse(String(init!.body));
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, patch);
      return Response.json(hit);
    }
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    return Response.json(rows.filter(match).slice(offset, offset + limit));
  }) as typeof fetch;
  return { tables, queries, restore: () => { globalThis.fetch = original; } };
}

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));
const NEW_KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => 200 - i)));

test("pass and invite tokens: sealed at rest, found by hash, readable by the app", async () => {
  const pg = fakePostgrest();
  try {
    const store = new SupabaseStore("https://db.example", "service", KEY);
    const token = "pass-token-abcdefghijklmnop";
    const saved = await store.insertBooking({ id: "b1", fleet_id: "f1", pass_token: token, plate: "PN74 EVH" } as unknown as BookingRow);
    assert.equal(saved.pass_token, token, "the app sees the real token");
    assert.equal("pass_token_hash" in saved, false, "the hash never leaves the store");

    const raw = pg.tables.get("bookings")![0];
    assert.match(String(raw.pass_token), /^enc:v1:/, "sealed in the database");
    assert.equal(raw.pass_token_hash, await sha256Hex(token));

    const found = await store.findBookingByPassToken(token);
    assert.equal(found?.id, "b1");
    assert.equal(found?.pass_token, token);
    const hash = await sha256Hex(token);
    assert.ok(pg.queries.some((q) => q.includes(`pass_token_hash=eq.${hash}`)));
    assert.ok(!pg.queries.some((q) => q.includes(token)), "the token itself is never sent in a query");
    assert.equal(await store.findBookingByPassToken("wrong"), null);

    // Resetting the link re-seals the new token and updates the hash.
    await store.updateBooking("b1", { pass_token: "new-token-zyxwvutsrqponml" });
    assert.equal((await store.findBookingByPassToken(token)), null, "old link stops working");
    assert.equal((await store.findBookingByPassToken("new-token-zyxwvutsrqponml"))?.id, "b1");
    // Other updates leave the token alone.
    const upd = await store.updateBooking("b1", { notes: "gate code 1234" });
    assert.equal(upd.pass_token, "new-token-zyxwvutsrqponml");

    const inv = await store.createInvite({ id: "i1", fleet_id: "f1", role: "planner", token: "invite-token-0123456789" } as FleetInvite);
    assert.equal(inv.token, "invite-token-0123456789");
    assert.match(String(pg.tables.get("fleet_invites")![0].token), /^enc:v1:/);
    assert.equal((await store.getInviteByToken("invite-token-0123456789"))?.id, "i1");
    assert.equal((await store.listInvites("f1"))[0].token, "invite-token-0123456789");
  } finally {
    pg.restore();
  }
});

test("re-encrypt seals links saved before, and re-seals after a key rotation", async () => {
  const pg = fakePostgrest();
  try {
    // A link saved before this change: plaintext, hash backfilled by the migration.
    pg.tables.set("bookings", [{ id: "old", fleet_id: "f1", pass_token: "legacy-token-aaaaaaaaaaaa", pass_token_hash: await sha256Hex("legacy-token-aaaaaaaaaaaa") }]);
    pg.tables.set("fleet_invites", []);
    const before = new SupabaseStore("https://db.example", "service", KEY);
    assert.equal((await before.findBookingByPassToken("legacy-token-aaaaaaaaaaaa"))?.pass_token, "legacy-token-aaaaaaaaaaaa", "plaintext still readable");
    assert.equal(await before.resealLinkTokens(), 1);
    const sealedOld = String(pg.tables.get("bookings")![0].pass_token);
    assert.match(sealedOld, /^enc:v1:/);

    // Rotation: new key, old one as previous; re-encrypt moves everything to the new key.
    const rotating = new SupabaseStore("https://db.example", "service", NEW_KEY, KEY);
    assert.equal(await rotating.resealLinkTokens(), 1);
    assert.notEqual(pg.tables.get("bookings")![0].pass_token, sealedOld);
    const after = new SupabaseStore("https://db.example", "service", NEW_KEY);
    assert.equal((await after.findBookingByPassToken("legacy-token-aaaaaaaaaaaa"))?.pass_token, "legacy-token-aaaaaaaaaaaa");
  } finally {
    pg.restore();
  }
});
