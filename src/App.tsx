import { useEffect, useState } from "react";
import type { Backend } from "./app/backend";
import { AppProvider, useApp } from "./app/state";
import { href, navigate, useRoute } from "./app/router";
import type { IconName } from "./ui/icon-data";
import { Avatar, BrandMark, Icon, Spinner, Toasts } from "./ui/ui";
import { DashboardPage } from "./pages/Dashboard";
import { BookPage } from "./pages/Book";
import { BookingsPage, bucket } from "./pages/Bookings";
import { BookingDrawer } from "./pages/BookingDrawer";
import { FleetPage } from "./pages/Fleet";
import { NetworkPage } from "./pages/Network";
import { SettingsPage } from "./pages/Settings";
import { PassPage } from "./pages/Pass";
import { Onboarding, PENDING_INVITE_KEY, SignIn } from "./pages/Auth";
import { JoinPage } from "./pages/Team";
import { MfaChallenge, MfaRequired } from "./pages/Security";
import { AdminMfaGate, CompliancePage } from "./pages/Compliance";
import { LegalPage } from "./legal/LegalPage";

export function App({ backend }: { backend: Backend }) {
  const route = useRoute();
  const [session, setSession] = useState(() => backend.auth?.session ?? null);
  useEffect(() => backend.auth?.onChange(setSession), [backend]);

  // Public pages: the driver pass and the legal documents need no sign-in.
  if (route.segments[0] === "pass" && route.segments[1]) return <PassPage backend={backend} token={route.segments[1]} />;
  if (route.segments[0] === "legal") return <LegalPage config={backend.config} doc={route.segments[1]} />;
  if (backend.mode === "live" && backend.auth && !session) {
    return <SignIn auth={backend.auth} config={backend.config} inviteToken={route.segments[0] === "join" ? route.segments[1] : undefined} />;
  }
  return (
    <AppProvider backend={backend} key={session?.user.id ?? "demo"}>
      <Shell />
    </AppProvider>
  );
}

const NAV: { path: string; label: string; icon: IconName; admin?: boolean }[] = [
  { path: "/", label: "Dashboard", icon: "dashboard" },
  { path: "/book", label: "Book", icon: "book" },
  { path: "/bookings", label: "Bookings", icon: "bookings" },
  { path: "/fleet", label: "Fleet", icon: "fleet" },
  { path: "/network", label: "Network", icon: "network", admin: true },
  { path: "/compliance", label: "Compliance", icon: "shieldCheck", admin: true },
  { path: "/settings", label: "Settings", icon: "settings" },
];

function Shell() {
  const app = useApp();
  const { me, meError, brand, backend, toasts, bookings, now } = app;
  const route = useRoute();
  const openId = route.params.get("open");
  // Finish an invite that started before sign-up (the confirmation email lands on the home page).
  useEffect(() => {
    if (!me) return;
    try {
      const token = localStorage.getItem(PENDING_INVITE_KEY);
      if (!token) return;
      localStorage.removeItem(PENDING_INVITE_KEY);
      if (route.segments[0] !== "join") navigate(`/join/${token}`);
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  const openBooking = (id: string) => navigate(route.path, { ...Object.fromEntries(route.params), open: id });
  const closeBooking = () => {
    const p = Object.fromEntries(route.params);
    delete p.open;
    navigate(route.path, p);
  };

  if (meError) {
    return <div className="auth-wrap"><div className="auth-card"><BrandMark brand={brand} /><p>{meError}</p><button className="btn" onClick={() => window.location.reload()}>Try again</button>{backend.auth && <button className="btn ghost" onClick={() => backend.auth!.signOut()}>Sign out</button>}</div></div>;
  }
  if (!me) return <div className="auth-wrap"><Spinner label="Loading" /></div>;
  // Two-step verification comes before anything else (the API refuses everything but /me until then).
  if (app.mfaGate === "challenge" && backend.auth) return <MfaChallenge auth={backend.auth} email={me.user.email} onDone={() => void app.refreshMe()} />;
  if (app.mfaGate === "enrol") return <MfaRequired fleetName={me.memberships.find((m) => m.fleet_id === app.fleetId)?.fleet_name ?? "Your fleet"} onDone={() => void app.refreshMe()} />;
  if (route.segments[0] === "join" && route.segments[1]) return <JoinPage token={route.segments[1]} />;
  if (!me.memberships.length) return <Onboarding />;

  const active = (path: string) => (path === "/" ? ["/", "/dashboard", "/today"].includes(route.path) : route.path === path || route.path.startsWith(`${path}/`));
  const nav = NAV.filter((n) => !n.admin || me.is_admin);
  const problems = bookings.filter((b) => bucket(b, now) === "problems" && new Date(b.updated_at).getTime() > now.getTime() - 36 * 3_600_000).length;
  const page = route.segments[0] ?? "";
  const role = me.memberships.find((m) => m.fleet_id === app.fleetId)?.role;
  const termsOutdated = role === "owner" && !!app.fleet && app.fleet.terms_version !== app.config.terms_version;

  return (
    <div className="shell">
      <aside className="rail" aria-label="Main">
        <BrandMark brand={brand} />
        <nav className="nav">
          {nav.filter((n) => n.path !== "/settings").map((n) => (
            <a key={n.path} href={href(n.path)} aria-current={active(n.path) ? "page" : undefined}>
              <Icon name={n.icon} />{n.label}
              {n.path === "/bookings" && problems > 0 && <span className="count" aria-label={`${problems} need attention`}>{problems}</span>}
            </a>
          ))}
        </nav>
        <div className="spacer" />
        <nav className="nav">
          <a href={href("/settings")} aria-current={active("/settings") ? "page" : undefined}><Icon name="settings" />Settings</a>
        </nav>
        <div className="who">
          <Avatar name={me.user.email ?? "You"} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small ellipsis" style={{ fontWeight: 560 }}>{me.memberships.find((m) => m.fleet_id === app.fleetId)?.fleet_name}</div>
            <div className="xs muted ellipsis">{me.user.email}</div>
          </div>
        </div>
        {me.memberships.length > 1 && (
          <select className="select" style={{ marginTop: 8, height: 32 }} value={app.fleetId ?? ""} onChange={(e) => app.setFleetId(e.target.value)} aria-label="Fleet">
            {me.memberships.map((m) => <option key={m.fleet_id} value={m.fleet_id}>{m.fleet_name}</option>)}
          </select>
        )}
      </aside>

      <div className="main">
        <header className="topbar">
          <BrandMark brand={brand} />
          <span className="grow" />
          {me.is_admin && <a className="btn ghost sm icon-only" href={href("/compliance")} aria-label="Security and compliance"><Icon name="shieldCheck" /></a>}
          {me.is_admin && <a className="btn ghost sm icon-only" href={href("/network")} aria-label="Network"><Icon name="network" /></a>}
          <a className="btn ghost sm icon-only" href={href("/settings")} aria-label="Settings"><Icon name="settings" /></a>
        </header>
        {backend.mode === "demo" && (
          <div className="demo-bar" role="note">
            <span className="dot" aria-hidden="true" />
            <span className="grow"><span className="long">Demo mode: operators are simulated and data stays in this browser. Add your Supabase keys to go live.</span><span className="short">Demo mode. Data stays in this browser.</span></span>
            <button className="btn sm ghost" onClick={() => backend.reset?.()}>Reset</button>
          </div>
        )}
        {termsOutdated && <TermsBanner />}
        <main>
          {page === "" || page === "dashboard" || page === "today" ? <DashboardPage openBooking={openBooking} />
            : page === "book" ? <BookPage />
            : page === "bookings" ? <BookingsPage openBooking={openBooking} />
            : page === "fleet" ? <FleetPage />
            : page === "network" ? <AdminMfaGate><NetworkPage /></AdminMfaGate>
            : page === "settings" ? <SettingsPage />
            : page === "compliance" && me.is_admin ? <CompliancePage />
            : <div className="page"><h1>Page not found</h1><p className="muted" style={{ marginTop: 8 }}><a href={href("/")}>Go to the dashboard</a></p></div>}
        </main>
      </div>

      <nav className="tabbar" aria-label="Main">
        {nav.filter((n) => n.path !== "/network" && n.path !== "/compliance" && n.path !== "/settings").concat([{ path: "/settings", label: "More", icon: "more" }]).map((n) => (
          <a key={n.path} href={href(n.path)} aria-current={active(n.path) ? "page" : undefined}><Icon name={n.icon} />{n.label}</a>
        ))}
      </nav>

      {openId && <BookingDrawer id={openId} onClose={closeBooking} />}
      <Toasts toasts={toasts} />
    </div>
  );
}

/** Fleet owners accept new versions of the terms for their organisation (they're told 30 days ahead). */
function TermsBanner() {
  const { api, fleetId, refreshFleet, toast, config } = useApp();
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await api("PATCH", `/fleets/${fleetId}`, { accept_terms: true });
      await refreshFleet();
      toast("Thanks, the updated terms are accepted for your organisation");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't record that", "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="terms-bar" role="note">
      <Icon name="fileText" size="sm" />
      <span className="grow small">We've updated the <a href={href("/legal/terms")}>terms of service</a> and <a href={href("/legal/dpa")}>data processing terms</a> (version {config.terms_version}). Please review and accept them for your organisation.</span>
      <button className="btn sm primary" disabled={busy} onClick={accept}>{busy && <Spinner />}Accept</button>
    </div>
  );
}
