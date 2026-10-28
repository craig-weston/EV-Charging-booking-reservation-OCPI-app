import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalOrigin } from "../src/app/canonical";

const at = (u: string) => { const x = new URL(u); return { hostname: x.hostname, origin: x.origin }; };
const versions = "https://depotcharge.craigweston.co.uk/ocpi/versions";

test("the production workers.dev address moves to the platform's own domain", () => {
  assert.equal(canonicalOrigin(at("https://depotcharge.craig-weston1.workers.dev/"), versions), "https://depotcharge.craigweston.co.uk");
});

test("previews, the domain itself, other hosts and workers.dev-only setups stay put", () => {
  assert.equal(canonicalOrigin(at("https://3f2a9c1e-depotcharge.craig-weston1.workers.dev/"), versions), null);
  assert.equal(canonicalOrigin(at("https://depotcharge.craigweston.co.uk/"), versions), null);
  assert.equal(canonicalOrigin(at("http://localhost:5173/"), versions), null);
  assert.equal(canonicalOrigin(at("https://depotcharge.craig-weston1.workers.dev/"), "https://depotcharge.craig-weston1.workers.dev/ocpi/versions"), null);
  assert.equal(canonicalOrigin(at("https://depotcharge.craig-weston1.workers.dev/"), "not a url"), null);
});
