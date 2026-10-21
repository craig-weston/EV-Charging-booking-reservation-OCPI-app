// Team: invite links, roles and leaving, with several signed-in users sharing one store.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FleetInvite, InvitePreview, TeamView } from "../shared/model";
import { createLocalCtx, dispatch } from "../server/dispatch";
import { harness, type Harness } from "./helpers";

function as(h: Harness, id: string, email: string) {
  const ctx = createLocalCtx({ store: h.store, simDelayMs: 0, now: () => h.clock.now, user: { id, email }, env: { OCPI_COUNTRY_CODE: "GB", OCPI_PARTY_ID: "DPC" } });
  return async <T = unknown>(method: string, path: string, body?: unknown) => {
    const res = await dispatch(new Request(ctx.baseUrl + path, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer test" }, body: body === undefined ? undefined : JSON.stringify(body) }), ctx);
    const json = (await res.json()) as { data: T; error?: { message: string; code?: string } };
    return { status: res.status, data: json.data, error: json.error };
  };
}

test("invite links add colleagues once, with the role chosen by the owner", async () => {
  const h = await harness();
  const owner = h.api;
  const jo = as(h, "user-2", "jo@example.com");
  const sam = as(h, "user-3", "sam@example.com");

  const inv = await owner<FleetInvite>("POST", `/api/fleets/${h.fleetId}/invites`, { email: "Jo@Example.com", role: "planner" });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.email, "jo@example.com");
  assert.ok(inv.data.token.length >= 24);

  // The preview works signed out (sign-in screen) and signed in.
  const anon = createLocalCtx({ store: h.store, now: () => h.clock.now, user: null });
  const pub = await dispatch(new Request(`${anon.baseUrl}/api/invites/${inv.data.token}`), anon);
  assert.equal(pub.status, 200);
  assert.equal(((await pub.json()) as { data: InvitePreview }).data.fleet_name, "Demo Haulage");
  const preview = await jo<InvitePreview>("GET", `/api/invites/${inv.data.token}`);
  assert.deepEqual([preview.data.role, preview.data.already_member], ["planner", false]);

  const joined = await jo<{ fleet_id: string }>("POST", `/api/invites/${inv.data.token}/accept`);
  assert.equal(joined.status, 200);
  assert.equal(joined.data.fleet_id, h.fleetId);
  const me = await jo<{ memberships: { fleet_id: string; role: string }[] }>("GET", "/api/me");
  assert.deepEqual(me.data.memberships.map((m) => [m.fleet_id, m.role]), [[h.fleetId, "planner"]]);

  // Single use.
  const reused = await sam("POST", `/api/invites/${inv.data.token}/accept`);
  assert.equal(reused.status, 404);
  assert.equal(reused.error?.code, "INVITE_INVALID");

  // Planners can book and edit trucks but not manage the team.
  const vehicles = await jo<unknown[]>("GET", `/api/fleets/${h.fleetId}/vehicles`);
  assert.equal(vehicles.status, 200);
  assert.equal((await jo("POST", `/api/fleets/${h.fleetId}/invites`, { role: "viewer" })).status, 403);

  const team = await owner<TeamView>("GET", `/api/fleets/${h.fleetId}/team`);
  assert.deepEqual(team.data.members.map((m) => [m.email, m.role]), [["planner@example.com", "owner"], ["jo@example.com", "planner"]]);
  assert.equal(team.data.invites.length, 0);
  const joTeam = await jo<TeamView>("GET", `/api/fleets/${h.fleetId}/team`);
  assert.equal(joTeam.data.members.length, 2);
  assert.deepEqual(joTeam.data.invites, []); // tokens are for owners only
});

test("viewers can't change anything, invites expire, and a fleet always keeps an owner", async () => {
  const h = await harness();
  const owner = h.api;
  const sam = as(h, "user-3", "sam@example.com");

  const inv = await owner<FleetInvite>("POST", `/api/fleets/${h.fleetId}/invites`, { role: "viewer" });
  assert.equal((await sam("POST", `/api/invites/${inv.data.token}/accept`)).status, 200);
  const create = await sam("POST", `/api/fleets/${h.fleetId}/vehicles`, { name: "X", plate: "AB12 CDE", token_uid: "VID:001122334455", start_method: "AUTOCHARGE" });
  assert.equal(create.status, 403);
  assert.equal((await sam("GET", `/api/fleets/${h.fleetId}/bookings`)).status, 200);

  // Only owner can't step down or leave.
  const demote = await owner("PATCH", `/api/fleets/${h.fleetId}/members/${h.userId}`, { role: "planner" });
  assert.equal(demote.status, 409);
  assert.equal((await owner("DELETE", `/api/fleets/${h.fleetId}/members/${h.userId}`)).status, 409);
  // Promote Sam, then the original owner may step down.
  assert.equal((await owner("PATCH", `/api/fleets/${h.fleetId}/members/user-3`, { role: "owner" })).status, 200);
  assert.equal((await owner("PATCH", `/api/fleets/${h.fleetId}/members/${h.userId}`, { role: "viewer" })).status, 200);
  assert.equal((await owner("PATCH", `/api/fleets/${h.fleetId}/members/user-3`, { role: "planner" })).status, 403);

  // Anyone may leave.
  assert.equal((await owner("DELETE", `/api/fleets/${h.fleetId}/members/${h.userId}`)).status, 200);
  assert.equal((await owner("GET", `/api/fleets/${h.fleetId}/vehicles`)).status, 404);

  // Expired links stop working and drop out of the list.
  const late = await sam<FleetInvite>("POST", `/api/fleets/${h.fleetId}/invites`, { email: "late@example.com" });
  h.clock.now = new Date(h.clock.now.getTime() + 8 * 86_400_000);
  const lee = as(h, "user-4", "late@example.com");
  assert.equal((await lee("GET", `/api/invites/${late.data.token}`)).status, 404);
  assert.equal((await sam<TeamView>("GET", `/api/fleets/${h.fleetId}/team`)).data.invites.length, 0);
  assert.equal((await sam("POST", `/api/fleets/${h.fleetId}/invites`, { email: "not-an-email" })).status, 400);
});
