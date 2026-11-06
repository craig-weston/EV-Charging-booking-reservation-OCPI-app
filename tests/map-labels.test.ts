// The booking map: a place name or road number under a price tag is hidden, so "CHEAPEST" never
// sits on top of "Birmingham".
import { test } from "node:test";
import assert from "node:assert/strict";
import { CITIES, ROAD_LABELS } from "../src/map/ukmap";
import { labelsUnderTags } from "../src/components/NetworkMap";

test("labels under a price tag are hidden; the rest stay", () => {
  const vb = { x: 0, y: 0 }, u = 1; // one map unit per screen pixel
  const brum = CITIES.find((c) => c.name === "Birmingham")!;
  // A tag with its CHEAPEST caption just right of Birmingham's dot, over its name.
  const tag = { x0: brum.x + 20, y0: brum.y - 50, x1: brum.x + 70, y1: brum.y + 3 };
  const { hiddenCities, hiddenRoads } = labelsUnderTags([tag], vb, u);
  assert.ok(hiddenCities.has("Birmingham"));
  assert.ok(!hiddenCities.has("London") && !hiddenCities.has("Glasgow"));
  const road = ROAD_LABELS[0];
  assert.ok(labelsUnderTags([{ x0: road.x - 5, y0: road.y - 5, x1: road.x + 5, y1: road.y + 5 }], vb, u).hiddenRoads.has(road.ref));
  assert.equal(labelsUnderTags([], vb, u).hiddenCities.size, 0);
  assert.ok(!hiddenRoads.has("M25"), "far away");
});
