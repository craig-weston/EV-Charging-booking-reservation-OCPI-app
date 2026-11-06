// The booking map: a price tag never sits on a place name. The name moves below or to the left of
// its dot instead, and is hidden only if tags cover every side; road numbers under a tag are hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CITIES, ROAD_LABELS } from "../src/map/ukmap";
import { placeLabels } from "../src/components/NetworkMap";

test("a place name under a price tag moves aside; hidden only when there's no room", () => {
  const vb = { x: 0, y: 0 }, u = 1; // one map unit per screen pixel
  const brum = CITIES.find((c) => c.name === "Birmingham")!;
  // A tag with its CHEAPEST caption just above and right of Birmingham's dot, over its name.
  const tag = { x0: brum.x + 10, y0: brum.y - 50, x1: brum.x + 70, y1: brum.y + 2 };
  assert.equal(placeLabels([], vb, u).cities.get("Birmingham"), "right", "as usual");
  assert.equal(placeLabels([tag], vb, u).cities.get("Birmingham"), "below");
  const under = { x0: brum.x - 40, y0: brum.y + 4, x1: brum.x + 40, y1: brum.y + 30 };
  assert.equal(placeLabels([tag, under], vb, u).cities.get("Birmingham"), "left");
  const all = { x0: brum.x - 120, y0: brum.y - 60, x1: brum.x + 120, y1: brum.y + 60 };
  assert.equal(placeLabels([all], vb, u).cities.has("Birmingham"), false, "covered on every side");
  assert.equal(placeLabels([tag], vb, u).cities.get("London"), "right", "far away: untouched");
  const road = ROAD_LABELS[0];
  assert.ok(placeLabels([{ x0: road.x - 5, y0: road.y - 5, x1: road.x + 5, y1: road.y + 5 }], vb, u).hiddenRoads.has(road.ref));
  assert.equal(placeLabels([], vb, u).hiddenRoads.size, 0);
});
