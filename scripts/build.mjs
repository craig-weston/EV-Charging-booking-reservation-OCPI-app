// Builds the web app with esbuild into dist/ (served by Cloudflare Workers or Pages).
//   node scripts/build.mjs               production build → dist/
//   node scripts/build.mjs --upload      also dist-upload/ with _worker.js, for a Pages dashboard upload
//   node scripts/build.mjs --serve       dev server on http://localhost:5173 (demo mode, rebuilds on change)
//   node scripts/build.mjs --single-file one self-contained HTML (demo mode) → dist-preview/index.html
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const args = new Set(process.argv.slice(2));
const serve = args.has("--serve");
const single = args.has("--single-file");

// The typeface is self-hosted (src/assets/fonts): no third-party requests from the app.
function html({ css, js, inlineCss, inlineJs, forceDemo, preload = [], fonts = [] }) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2f5bea">
<meta name="description" content="Book HGV charging slots at depots and hubs, built on OCPI 2.3.0 Bookings.">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>Depotcharge</title>
${fonts.map((f) => `<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`).join("\n")}
${single ? "" : `<link rel="icon" href="/favicon.svg">`}
${inlineCss ? `<style>${inlineCss}</style>` : `<link rel="stylesheet" href="${css}">`}
${preload.map((p) => `<link rel="modulepreload" href="${p}">`).join("\n")}
</head>
<body>
<div id="root"><div class="boot" role="status">Loading…</div></div>
${forceDemo ? "<script>window.__DEPOTCHARGE_FORCE_DEMO__ = true;</script>" : ""}
${inlineJs ? `<script type="module">${inlineJs.replace(/<\/script/gi, "<\\/script")}</script>` : `<script type="module" src="${js}"></script>`}
</body>
</html>
`;
}

const common = {
  absWorkingDir: root,
  entryPoints: ["src/main.tsx"],
  bundle: true,
  format: "esm",
  target: ["es2021", "chrome100", "safari15", "firefox100"],
  jsx: "automatic",
  loader: { ".svg": "text", ".woff2": "file" },
  assetNames: "[name]-[hash]",
  define: { "process.env.NODE_ENV": serve ? '"development"' : '"production"' },
  legalComments: "none",
  logLevel: "info",
};

function copyPublic(out) {
  const pub = path.join(root, "public");
  if (!fs.existsSync(pub)) return;
  fs.cpSync(pub, out, { recursive: true });
}

/** The browser calls Supabase Auth directly, so the Content-Security-Policy must allow its origin. */
function supabaseOrigin() {
  const raw = (process.env.SUPABASE_URL ?? "").trim();
  if (!raw) return "https://*.supabase.co";
  let u;
  try { u = new URL(raw); } catch { throw new Error(`SUPABASE_URL is not a valid URL: ${raw}`); }
  if (u.protocol !== "https:") throw new Error("SUPABASE_URL must start with https://");
  return u.origin;
}

/**
 * RFC 9116 security.txt so researchers know where to report vulnerabilities. Generated at build
 * time from SECURITY_CONTACT (an email address or https:// URL); Expires is set ~11 months out,
 * so any deploy within the year keeps it current.
 */
function writeSecurityTxt(out) {
  const contact = (process.env.SECURITY_CONTACT || process.env.LEGAL_CONTACT_EMAIL || "").trim();
  if (!contact) {
    console.warn("  ! SECURITY_CONTACT is not set: /.well-known/security.txt was not generated (see docs/deploy.md)");
    return;
  }
  const value = /^https:\/\//i.test(contact) ? contact : `mailto:${contact.replace(/^mailto:/i, "")}`;
  const expires = new Date(Date.now() + 335 * 86_400_000);
  expires.setUTCHours(0, 0, 0, 0);
  const base = (process.env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const lines = [
    `Contact: ${value}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    ...(base ? [`Canonical: ${base}/.well-known/security.txt`, `Policy: ${base}/#/legal/security`] : []),
  ];
  fs.mkdirSync(path.join(out, ".well-known"), { recursive: true });
  fs.writeFileSync(path.join(out, ".well-known", "security.txt"), `${lines.join("\n")}\n`);
}

if (serve) {
  const out = path.join(root, ".dev");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.html"), html({ css: "/main.css", js: "/main.js" }));
  copyPublic(out);
  const ctx = await esbuild.context({ ...common, outdir: out, sourcemap: true, splitting: true, entryNames: "[name]", chunkNames: "chunks/[name]-[hash]" });
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: out, port: 5173 });
  console.log(`\n  Demo mode running at http://localhost:${port}\n  (use "npm run pages:dev" after "npm run build" to run with the Pages Functions)\n`);
} else if (single) {
  const out = path.join(root, "dist-preview");
  fs.mkdirSync(out, { recursive: true });
  const r = await esbuild.build({ ...common, loader: { ...common.loader, ".woff2": "dataurl" }, write: false, outdir: out, minify: true, entryNames: "[name]" });
  const js = r.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const css = r.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  fs.writeFileSync(path.join(out, "index.html"), html({ inlineCss: css, inlineJs: js, forceDemo: true }));
  // The same demo as a body fragment for hosts that supply their own document skeleton.
  const fragment = `<title>Depotcharge</title>
<style>${css}</style>
<div id="root"><div class="boot" role="status">Loading…</div></div>
<script>window.__DEPOTCHARGE_FORCE_DEMO__ = true;</script>
<script type="module">${js.replace(/<\/script/gi, "<\\/script")}</script>
`;
  fs.writeFileSync(path.join(out, "fragment.html"), fragment);
  console.log(`wrote dist-preview/index.html (${Math.round((js.length + css.length) / 1024)} KB)`);
} else {
  const out = path.join(root, "dist");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "assets"), { recursive: true });
  // Content-hashed names (cached forever, see public/_headers); the demo backend is its own chunk.
  const r = await esbuild.build({
    ...common, outdir: path.join(out, "assets"), minify: true, sourcemap: "linked", splitting: true, metafile: true,
    entryNames: "app-[hash]", chunkNames: "chunk-[hash]",
  });
  const url = (file) => `/${path.relative(out, path.resolve(root, file)).split(path.sep).join("/")}`;
  const [entryFile, entry] = Object.entries(r.metafile.outputs).find(([, m]) => m.entryPoint === "src/main.tsx");
  const names = { ".js": url(entryFile), ".css": entry.cssBundle ? url(entry.cssBundle) : null };
  // Preload the chunks the entry imports statically so they don't load one after another.
  const preload = entry.imports.filter((i) => i.kind === "import-statement").map((i) => url(i.path));
  const fonts = Object.keys(r.metafile.outputs).filter((f) => f.endsWith(".woff2")).map(url);
  fs.writeFileSync(path.join(out, "index.html"), html({ css: names[".css"], js: names[".js"], preload, fonts }));
  copyPublic(out);
  const headersFile = path.join(out, "_headers");
  // https for Auth, wss for Realtime live updates (listed explicitly for older browsers).
  const sb = supabaseOrigin();
  fs.writeFileSync(headersFile, fs.readFileSync(headersFile, "utf8").replaceAll("__SUPABASE_ORIGIN__", `${sb} ${sb.replace(/^https:/, "wss:")}`));
  writeSecurityTxt(out);
  console.log(`built dist/ → ${names[".js"]} ${names[".css"]}`);

  if (args.has("--upload")) {
    // Cloudflare Pages dashboard upload (drag and drop a folder or zip): Pages can't compile the
    // functions/ folder there, but it runs an advanced-mode _worker.js. _routes.json sends only
    // the dynamic paths to it, so static files keep the headers from _headers.
    const up = path.join(root, "dist-upload");
    fs.rmSync(up, { recursive: true, force: true });
    fs.cpSync(out, up, { recursive: true });
    for (const f of fs.readdirSync(path.join(up, "assets"))) if (f.endsWith(".map")) fs.rmSync(path.join(up, "assets", f));
    await esbuild.build({
      absWorkingDir: root, entryPoints: ["worker/index.ts"], bundle: true, format: "esm", platform: "neutral",
      target: "es2022", minify: true, legalComments: "none", outfile: path.join(up, "_worker.js"), logLevel: "warning",
    });
    fs.writeFileSync(path.join(up, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*", "/ocpi/*", "/sim/*"], exclude: [] }, null, 2));
    console.log("built dist-upload/ (static app + _worker.js) for a Cloudflare Pages dashboard upload");
  }
}
