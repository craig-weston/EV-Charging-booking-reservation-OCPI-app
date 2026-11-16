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
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".txt": "text/plain", ".json": "application/json" };

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
    // /map is the public charging map (dist/map.html), as Cloudflare serves it.
    let file = path.join(DIST, url.pathname === "/map" ? "map.html" : decodeURIComponent(url.pathname));
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
  await page.evaluate(() => document.querySelectorAll("details.more-row").forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await page.getByRole("button", { name: "Save branding" }).waitFor({ timeout: 15_000 });
  await axe(page, "settings, every row open");
  await page.goto(`${base}/#/team`);
  await page.waitForTimeout(1500);
  await axe(page, "team");
  await page.goto(`${base}/#/network/connect`);
  await page.getByRole("heading", { name: "Connect a real operator" }).waitFor({ timeout: 15_000 });
  await axe(page, "operator guide");
  await page.getByRole("button", { name: /Check their interface, then connect/ }).click();
  await page.getByRole("textbox", { name: "Their versions URL" }).waitFor();
  await axe(page, "operator guide (connect step)");
  await page.goto(`${base}/#/network`);
  await page.getByRole("heading", { name: "Network", level: 1 }).waitFor({ timeout: 15_000 });
  await axe(page, "network");
  await page.evaluate(() => document.querySelectorAll("details.more-row").forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await page.getByText("Margin on operator prices (%)").waitFor({ timeout: 15_000 });
  await axe(page, "network, every row open");
  await page.goto(`${base}/#/compliance`);
  await page.getByRole("heading", { name: "Security & compliance", level: 1 }).waitFor({ timeout: 15_000 });
  await page.getByText(/Cyber Essentials readiness/).waitFor({ timeout: 15_000 });
  await axe(page, "compliance");
  await page.evaluate(() => document.querySelectorAll("details.more-row").forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await page.waitForTimeout(500);
  await axe(page, "compliance, every row open");
  await page.goto(`${base}/#/operators`);
  await page.getByRole("heading", { name: "Fill your HGV bays with booked trucks" }).waitFor({ timeout: 15_000 });
  await axe(page, "for operators");
  await page.goto(`${base}/#/trip`);
  await page.getByRole("heading", { name: "Plan a trip" }).waitFor({ timeout: 15_000 });
  await axe(page, "trip planner");
  await page.goto(`${base}/#/savings`);
  await page.getByRole("heading", { name: "Savings", level: 1 }).waitFor({ timeout: 15_000 });
  await axe(page, "savings");
  await page.evaluate(() => document.querySelectorAll("details.more-row").forEach((d) => ((d as HTMLDetailsElement).open = true)));
  await axe(page, "savings, details open");
  await page.goto(`${base}/#/energy`);
  await page.getByRole("heading", { name: "Charging plan" }).waitFor({ timeout: 15_000 });
  await axe(page, "depot smart charging");
  for (const t of ["Chargers", "Grid flexibility", "Vehicle-to-grid pilot"]) await page.locator("summary", { hasText: t }).first().click();
  await axe(page, "depot smart charging, details open");
  // The plan reaches the (simulated) chargers; Bay 3 reports a fault and the plan works around it.
  await page.getByRole("button", { name: "Send the plan to the chargers" }).click();
  await page.getByText("Bay 3 has a fault").first().waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Move to Bay 5" }).waitFor({ timeout: 5_000 });
  await axe(page, "depot smart charging, a charger fault");
  await page.getByRole("button", { name: "Move to Bay 5" }).click();
  await page.getByText(/All \d+ trucks will be ready on time/).first().waitFor({ timeout: 15_000 });
  await page.goto(`${base}/#/statements`);
  await page.getByRole("heading", { name: "Charging statement" }).waitFor({ timeout: 15_000 });
  await page.getByText("Total incl. VAT").first().waitFor({ timeout: 15_000 });
  await axe(page, "charging statement");
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
  for (const hash of ["#/book", "#/bookings", "#/statements", "#/savings", "#/fleet", "#/network", "#/settings", "#/compliance"]) {
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

// ---- the public charging map (/map): no account, its own page

/** A few public sites, as GET /api/public/sites returns them. */
const MAP_SITES = {
  generated_at: "2026-11-14T09:00:00Z",
  sources: [{ id: "ocm", name: "Open Charge Map", attribution: "CC BY 4.0", url: "https://openchargemap.org", count: 3 }],
  sites: [
    { id: "ocm:1", name: "Markham Moor Truck Stop", operator: "Shell Recharge", lat: 53.27, lon: -0.94, city: "Retford", max_kw: 175, connectors: ["CCS2"], evses: 4, hgv: "trucks", hgv_why: "Truck bays", open247: true, facilities: ["CAFE", "FUEL_STATION"], source: "ocm" },
    { id: "ocm:2", name: "Donington Park Services", operator: "GRIDSERVE", lat: 52.83, lon: -1.31, city: "Castle Donington", max_kw: 360, connectors: ["CCS2"], evses: 12, hgv: "check", hgv_why: "", source: "ocm" },
    { id: "ocm:3", name: "Daventry Megawatt Hub", operator: "Milence", lat: 52.27, lon: -1.16, city: "Daventry", max_kw: 1000, connectors: ["MCS", "CCS2"], evses: 8, hgv: "trucks", hgv_why: "MCS connector", source: "ocm" },
  ],
};

async function openMap(ctx: BrowserContext): Promise<{ page: Page; problems: string[] }> {
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  // The page's data from this deployment's API, and a plain street-map style instead of the real
  // map host, so the test never depends on the network.
  await page.route("**/api/public/sites", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ data: MAP_SITES }) }));
  await page.route("**/api/public/site-reports", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ data: {} }) }));
  await page.route("**/api/config", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("https://tiles.openfreemap.org/**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": "#f2f3f0" } }] }) }));
  await page.goto(`${base}/map`);
  return { page, problems: problems.filter((p) => !/api\/config|404/.test(p)) };
}

test("public map: welcome, list, a site, a trial booking and a phone pass accessibility checks", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const { page, problems } = await openMap(ctx);
  // First visit: the welcome card.
  const explore = page.getByRole("button", { name: "Explore the map" });
  await explore.waitFor({ timeout: 15_000 });
  await axe(page, "public map (welcome)");
  // The booking video, from the welcome card: a dialog with the steps written out.
  await page.getByRole("button", { name: /Watch how booking works/ }).first().click();
  await page.getByRole("dialog", { name: "How booking works" }).waitFor();
  await page.getByText("Bay reserved in seconds").waitFor();
  await axe(page, "public map (video)");
  await page.getByRole("button", { name: "Close the video" }).click();
  await page.getByRole("dialog", { name: "How booking works" }).waitFor({ state: "detached" });
  // The list: truck sites first.
  const items = page.locator(".pm-item");
  await items.first().waitFor();
  assert.equal(await items.count(), 3);
  assert.match(await items.first().innerText(), /Daventry Megawatt Hub|Markham Moor Truck Stop/);
  await axe(page, "public map (list)");
  // Filters narrow the list.
  await page.getByRole("button", { name: "24/7", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".pm-item").length === 1);
  await page.getByRole("button", { name: "Clear" }).click();
  // A site: its details and HGV checklist.
  await page.locator(".pm-item", { hasText: "Markham Moor Truck Stop" }).click();
  await page.getByRole("heading", { name: "Markham Moor Truck Stop", level: 2 }).waitFor();
  await page.getByText("HGV checklist for an artic").waitFor();
  await axe(page, "public map (site)");
  // The trial booking, to the end.
  await page.getByRole("button", { name: "Try booking this site" }).click();
  const reserve = page.getByRole("button", { name: /Reserve a bay/ });
  await reserve.waitFor();
  await axe(page, "public map (trial booking)");
  await reserve.click();
  await page.getByText("Bay reserved").waitFor();
  await page.getByRole("link", { name: "Create your account" }).waitFor();
  await axe(page, "public map (trial booked)");
  assert.match(page.url(), /#site=ocm%3A1$/, "the address links to the site");
  assert.deepEqual(problems, []);
  noA11yProblems();
  await ctx.close();
});

test("public map: keyboard reaches search, the truck switch and a site; a phone shows the sheet", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const { page, problems } = await openMap(ctx);
  await page.getByRole("button", { name: "Explore the map" }).click({ timeout: 15_000 });
  await page.locator(".pm-item").first().waitFor();
  // Search by keyboard: type, arrow down, Enter opens the site.
  await page.getByRole("combobox", { name: /Search a town/ }).focus();
  await page.keyboard.type("daven");
  await page.getByRole("option", { name: /Daventry Megawatt Hub/ }).waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Daventry Megawatt Hub", level: 2 }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "pm-site-name", "focus moves to the site's name");
  // Every control the keyboard reaches is visible and named.
  const unnamed: string[] = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? (el as HTMLInputElement).value ?? "").trim();
      return { tag: el.tagName, name, visible: r.width > 0 && r.height > 0, small: r.width < 24 || r.height < 24 };
    });
    if (f && (!f.visible || !f.name)) unnamed.push(JSON.stringify(f));
  }
  assert.deepEqual(unnamed, [], "focused controls are visible and named");

  // A phone: the panel is a bottom sheet; the list opens and passes checks.
  const phone = await ctx.newPage();
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.route("**/api/public/sites", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ data: MAP_SITES }) }));
  await phone.route("**/api/public/site-reports", (r) => r.fulfill({ contentType: "application/json", body: "{}" }));
  await phone.route("**/api/config", (r) => r.fulfill({ status: 404, body: "" }));
  await phone.route("https://tiles.openfreemap.org/**", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ version: 8, sources: {}, layers: [] }) }));
  await phone.goto(`${base}/map`);
  await phone.getByRole("button", { name: "Show the list" }).click({ timeout: 15_000 });
  await phone.locator(".pm-item").first().waitFor();
  await axe(phone, "public map (phone)");
  const scroll = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(scroll <= 0, `no horizontal scrolling (${scroll}px)`);
  assert.deepEqual(problems, []);
  noA11yProblems();
  await ctx.close();
});

test("public map: a number plate finds the truck, saves it in the browser, and sets up the map", async () => {
  const ctx = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1280, height: 800 } });
  const { page, problems } = await openMap(ctx);
  const details = { plate: "BK74 RGD", make: "Daf", fuel: "ELECTRICITY", electric: true, year: 2024, colour: "White", gross_weight_kg: 26000, wheel_plan: "3 AXLE RIGID BODY", type_approval: "N3", kind: "rigid", vehicle_type: "RIGID", typical: { length_cm: 1100, height_cm: 380, width_cm: 255 }, heavy: true };
  let asked: unknown = null;
  await page.route("**/api/public/plate", async (r) => {
    asked = r.request().postDataJSON();
    const plate = String((asked as { plate?: string }).plate ?? "");
    if (/ZZ99/.test(plate)) return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "DVLA has no vehicle with that number plate" } }) });
    return r.fulfill({ contentType: "application/json", body: JSON.stringify({ data: details }) });
  });
  await page.getByRole("button", { name: "Explore the map" }).click({ timeout: 15_000 });
  const box = page.getByLabel("Your truck's number plate");
  await box.fill("zz99 zzz");
  await page.getByRole("button", { name: "Find", exact: true }).click();
  await page.getByText("DVLA has no vehicle with that number plate").waitFor();
  await box.fill("bk74 rgd");
  await box.press("Enter");
  await page.getByText(/Found BK74 RGD: Daf, rigid, 26 t/).waitFor();
  assert.deepEqual(asked, { plate: "BK74 RGD" });
  // Saved as one of "Your trucks", and the map now plans for a rigid.
  await page.getByRole("list", { name: "Your trucks" }).getByText("BK74 RGD").waitFor();
  assert.equal(await page.getByRole("radio", { name: /Rigid/ }).getAttribute("aria-checked"), "true");
  await axe(page, "public map (plate found)");
  // Still there after a reload.
  await page.reload();
  await page.getByRole("list", { name: "Your trucks" }).getByText("BK74 RGD").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Remove BK74 RGD" }).click();
  await page.getByRole("list", { name: "Your trucks" }).waitFor({ state: "detached" });
  assert.deepEqual(problems.filter((p) => !/404/.test(p)), []);
  noA11yProblems();
  await ctx.close();
});
