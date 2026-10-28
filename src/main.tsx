import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { App } from "./App";
import { createLiveBackend, fetchConfig, type Backend } from "./app/backend";
import { applyBrand } from "./app/brand";
import { canonicalOrigin } from "./app/canonical";
import { installErrorReporting } from "./app/errors";
import { ErrorBoundary } from "./components/ErrorBoundary";

declare global {
  interface Window {
    /** Set by the single-file preview build to skip the network check. */
    __DEPOTCHARGE_FORCE_DEMO__?: boolean;
  }
}

function sessionFlag(): boolean {
  try { return sessionStorage.getItem("depotcharge.try-demo") === "1"; } catch { return false; }
}

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  const config = window.__DEPOTCHARGE_FORCE_DEMO__ ? null : await fetchConfig();
  let backend: Backend;
  const live = !!(config && config.mode === "live" && config.supabase_url && config.supabase_anon_key);
  // Old links to the production workers.dev address move to the platform's own domain.
  const canonical = live && config ? canonicalOrigin(window.location, config.ocpi_versions_url) : null;
  if (canonical) {
    window.location.replace(canonical + window.location.pathname + window.location.search + window.location.hash);
    return;
  }
  // "Try the demo" on a live site: the in-browser demo, separate from any real account or data.
  const tryDemo = /^#\/demo(\/|\?|$)/.test(window.location.hash) || new URLSearchParams(window.location.search).has("demo") || sessionFlag();
  if (live && tryDemo) {
    const { createDemoBackend, demoRequested } = await import("./app/demo");
    if (demoRequested()) {
      backend = await createDemoBackend(config ?? undefined, { publicDemo: true });
      applyBrand(backend.config.brand);
      document.title = `${backend.config.brand.name} demo`;
      root.render(<ErrorBoundary><App backend={backend} /></ErrorBoundary>);
      return;
    }
  }
  if (live && config) {
    backend = createLiveBackend(config);
    installErrorReporting();
    try {
      backend.auth!.consumeRedirect();
    } catch (e) {
      console.warn(e);
    }
  } else {
    // The in-browser API + simulator only loads in demo mode, so live users never download it.
    const { createDemoBackend } = await import("./app/demo");
    backend = await createDemoBackend(config ?? undefined);
  }
  applyBrand(backend.config.brand);
  document.title = backend.config.brand.name;
  root.render(<ErrorBoundary><App backend={backend} /></ErrorBoundary>);
}

boot().catch((e) => {
  console.error(e);
  // Plain text only: an error message is never parsed as HTML.
  const box = document.createElement("div");
  box.className = "boot";
  box.textContent = `Couldn't start the app: ${String(e?.message ?? e)}`;
  document.getElementById("root")!.replaceChildren(box);
});
