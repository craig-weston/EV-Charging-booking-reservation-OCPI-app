// The stylesheet's braces balance, so a bad merge can't silently nest rules inside a media query.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("app.css: every block is closed", () => {
  const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "\"\"");
  let depth = 0;
  css.split("\n").forEach((line, i) => {
    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      assert.ok(depth >= 0, `unexpected } on line ${i + 1}`);
    }
  });
  assert.equal(depth, 0, "a block is left open at the end of the file");
});
