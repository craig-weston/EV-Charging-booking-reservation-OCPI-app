// Browser tests: the built app (dist/, demo mode) in real Chromium, served with the production
// Content-Security-Policy from dist/_headers. Checks the main journeys work, nothing logs an
// error or a CSP violation, and pages pass axe-core accessibility rules (WCAG 2.2 A/AA).
// Contexts ask for reduced motion, so contrast is never measured halfway through a fade-in.
//
//   npm run build && npm run test:e2e
//
// Needs `playwright` (with Chromium) and `axe-core`; CI installs both (see .github/workflows/ci.yml).
// Locally, without axe-core the accessibility checks are skipped unless CI=true.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";

const require = createRequire(import.meta.url);
// Fall back to a global install (E2E_MODULES=/path/to/node_modules) when not installed in the project.
function load<T>(name: string): T {
  try { return require(name) as T; } catch { /* try the fallback */ }
  if (process.env.E2E_MODULES) return createRequire(path.join(process.env.E2E_MODULES, "x.js"))(name) as T;
  throw new Error(`${name} isn't installed: npm install --no-save playwright axe-core`);
}
function resolveAxe(): string | null {
  for (const r of [require, process.env.E2E_MODULES ? createRequire(path.join(process.env.E2E_MODULES, "x.js")) : null]) {
    try { if (r) return r.resolve("axe-core/axe.min.js"); } catch { /* next */ }
  }
  return null;
}

const DIST = path.resolve("dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".txt": "text/plain", ".json": "application/json" };

/** Headers for every path from dist/_headers ("/*" block), as Cloudflare would send them. */
function siteHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = readFileSync(path.join(DIST, "_headers"), "utf8").split("\n");
  let inAll = false;
  for (const line of lines) {
    if (/^\S/.test(line)) inAll = line.trim() === "/*";
    else if (inAll && line.includes(":")) {
      const i = line.indexOf(":");
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  // Local http: upgrade-insecure-requests would rewrite our own requests to https.
  if (out["Content-Security-Policy"]) out["Content-Security-Policy"] = out["Content-Security-Policy"].replace(/;\s*upgrade-insecure-requests/, "");
  delete out["Strict-Transport-Security"];
  return out;
}

let server: Server;
let base = "";
let browser: Browser;
const axePath = resolveAxe();

before(async () => {
  assert.ok(existsSync(path.join(DIST, "index.html")), "run npm run build first");
  const headers = siteHeaders();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let file = path.join(DIST, decodeURIComponent(url.pathname));
    if (!file.startsWith(DIST)) { res.writeHead(400).end(); return; }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
    // No API here (so the app runs its in-browser demo); unknown paths are a plain 404.
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, headers).end("Not found"); return; }
    res.writeHead(200, { ...headers, "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  const { chromium } = load<typeof import("playwright")>("playwright");
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
});

/** A page that fails the test on any uncaught error, console error or CSP violation. */
async function open(ctx: BrowserContext, hash = "#/"): Promise<{ page: Page; problems: string[] }> {
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The app probes /api/config to choose live or demo mode; here there's no API, by design.
    if (m.type() === "error" && !m.location().url.endsWith("/api/config")) problems.push(`console: ${m.text()}`);
  });
  await page.goto(`${base}/${hash}`);
  return { page, problems };
}

async function axe(page: Page, label: string) {
  if (!axePath) {
    if (process.env.CI) assert.fail("axe-core is required in CI");
    return;
  }
  // Evaluated through the DevTools protocol, which the page's CSP doesn't apply to (an injected
  // <script> tag would be refused, and show up as a CSP violation).
  if (!(await page.evaluate(() => "axe" in window))) await page.evaluate(readFileSync(axePath, "utf8"));
  const result = await page.evaluate(async () => {
    const w = window as unknown as { axe: { run(ctx: Document, opts: object): Promise<{ violations: { id: string; impact: string; help: string; nodes: { target: string[] }[] }[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, targets: v.nodes.slice(0, 5).map((n) => `${n.target.join(" ")} ${(n as unknown as { html: string }).html.slice(0, 90)}`) }));
  });
  const serious = result.filter((v) => v.impact === "serious" || v.impact === "critical");
  for (const v of result.filter((x) => !serious.includes(x))) console.log(`  a11y (${label}, ${v.impact}): ${v.id}: ${v.help} → ${v.targets.join(", ")}`);
  // Collected rather than thrown, so one run reports every page's problems.
  for (const v of serious) a11y.push(`${label}: ${v.id} (${v.impact}): ${v.help}\n    ${v.targets.join("\n    ")}`);
}

const a11y: string[] = [];
function noA11yProblems() {
  const found = a11y.splice(0);
  assert.deepEqual(found, [], `serious accessibility problems:\n${found.join("\n")}`);
}

test("dashboard loads in demo mode, with no errors and no CSP violations", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const { page, problems } = await open(ctx);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  assert.deepEqual(problems, []);
  await axe(page, "dashboard");
  noA11yProblems();
  await ctx.close();
});

test("book a slot end to end, then open the driver pass on a phone", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const { page, problems } = await open(ctx, "#/book");
  const tomorrow = page.locator('[aria-label="Day"] .chip', { hasText: "Tomorrow" });
  await tomorrow.waitFor({ timeout: 15_000 });
  await axe(page, "book");
  await tomorrow.click();
  const item = page.locator("ul.list > li").first();
  await item.waitFor();
  const clickable = item.locator("button, a").first();
  await ((await clickable.count()) ? clickable : item).click();
  const request = page.getByRole("button", { name: /Request booking/ });
  await request.waitFor();
  await axe(page, "booking form");
  await request.click();
  // The in-browser operator simulator confirms over OCPI Bookings.
  await page.getByText("Send the driver their pass").waitFor({ timeout: 20_000 });
  const passHref = await page.getByRole("link", { name: /Open pass/ }).getAttribute("href");
  assert.match(passHref ?? "", /#\/pass\/[A-Za-z0-9_-]{16,}/);
  assert.deepEqual(problems, []);

  // The driver's phone: same browser storage, so the demo data matches.
  const phone = await ctx.newPage();
  const phoneProblems: string[] = [];
  phone.on("pageerror", (e) => phoneProblems.push(e.message));
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(new URL(passHref!, `${base}/`).toString());
  await phone.getByText(/plug in/i).first().waitFor({ timeout: 15_000 });
  await axe(phone, "driver pass (mobile)");
  assert.deepEqual(phoneProblems, []);
  noA11yProblems();
  await ctx.close();
});

test("settings and team pages pass accessibility checks; keyboard reaches the main nav", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const { page, problems } = await open(ctx, "#/settings");
  await page.getByRole("button", { name: "Save fleet settings" }).waitFor({ timeout: 15_000 });
  await axe(page, "settings");
  await page.goto(`${base}/#/team`);
  await page.waitForTimeout(1500);
  await axe(page, "team");
  // Keyboard: the first few Tabs land on visible, focusable controls (skip link or nav).
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el && el !== document.body ? { tag: el.tagName, visible: !!(el.offsetWidth || el.offsetHeight) } : null;
  });
  assert.ok(focused?.visible, "Tab moves focus to a visible control");
  assert.deepEqual(problems, []);
  noA11yProblems();
  await ctx.close();
});

test("dark mode and a phone-sized screen render without horizontal scrolling", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 375, height: 812 }, colorScheme: "dark" });
  const { page, problems } = await open(ctx);
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1000);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px on a phone`);
  await axe(page, "dashboard (dark, mobile)");
  // Every main page fits a phone, and the toasts and booking bar sit above the tab bar.
  for (const hash of ["#/book", "#/bookings", "#/fleet", "#/network", "#/settings", "#/compliance"]) {
    await page.goto(`${base}/${hash}`);
    await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sideways <= 1, `${hash} scrolls sideways by ${sideways}px on a phone`);
  }
  const clear = await page.evaluate(() => {
    const tab = document.querySelector(".tabbar")?.getBoundingClientRect();
    const toasts = document.querySelector(".toasts");
    return { tabTop: tab?.top ?? 0, toastsBottom: toasts ? parseFloat(getComputedStyle(toasts).bottom) : 999 };
  });
  assert.ok(clear.toastsBottom >= 56, `toasts sit ${clear.toastsBottom}px from the bottom, under the tab bar`);
  assert.deepEqual(problems, []);
  noA11yProblems();
  await ctx.close();
});
