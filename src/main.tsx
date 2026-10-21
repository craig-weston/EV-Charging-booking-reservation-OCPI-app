import { createRoot } from "react-dom/client";
import "./styles/app.css";
import { App } from "./App";
import { createLiveBackend, fetchConfig, type Backend } from "./app/backend";
import { applyBrand } from "./app/brand";

declare global {
  interface Window {
    /** Set by the single-file preview build to skip the network check. */
    __DEPOTCHARGE_FORCE_DEMO__?: boolean;
  }
}

async function boot() {
  const root = createRoot(document.getElementById("root")!);
  const config = window.__DEPOTCHARGE_FORCE_DEMO__ ? null : await fetchConfig();
  let backend: Backend;
  if (config && config.mode === "live" && config.supabase_url && config.supabase_anon_key) {
    backend = createLiveBackend(config);
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
  root.render(<App backend={backend} />);
}

boot().catch((e) => {
  console.error(e);
  // Plain text only: an error message is never parsed as HTML.
  const box = document.createElement("div");
  box.className = "boot";
  box.textContent = `Couldn't start the app: ${String(e?.message ?? e)}`;
  document.getElementById("root")!.replaceChildren(box);
});
