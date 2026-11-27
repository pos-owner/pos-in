import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import { useApi } from "./lib/api";
import { tr, useT } from "./lib/i18n";
import { onOutboxSent, useOutbox } from "./lib/outbox";
import { readPendingInvite } from "./lib/invite";
import { features } from "./lib/features";
import type { Dashboard } from "./lib/types";
import { SkeletonPage, TabBar, ToastProvider, useToast, type Tab } from "./components/kit";
import { I } from "./components/icons";
import { QuickSearch } from "./components/QuickSearch";

/* Screens are split per route so each role only downloads what it uses. */
const L = (f: () => Promise<{ default: ComponentType }>) => lazy(f);
const Welcome = L(() => import("./screens/auth/Welcome"));
const Onboarding = L(() => import("./screens/auth/Onboarding"));
const Join = L(() => import("./screens/auth/Join"));
const ResetPassword = L(() => import("./screens/auth/ResetPassword"));

const OwnerHome = L(() => import("./screens/owner/Home"));
const Rent = L(() => import("./screens/owner/Rent"));
const Tenants = L(() => import("./screens/owner/Tenants"));
const TenantDetail = L(() => import("./screens/owner/TenantDetail"));
const More = L(() => import("./screens/owner/More"));
const Properties = L(() => import("./screens/owner/Properties"));
const Invites = L(() => import("./screens/owner/Invites"));

const Requests = L(() => import("./screens/shared/Requests"));
const RequestDetail = L(() => import("./screens/shared/RequestDetail"));
const Expenses = L(() => import("./screens/shared/Expenses"));
const Settings = L(() => import("./screens/shared/Settings"));

const TenantHome = L(() => import("./screens/tenant/Home"));
const History = L(() => import("./screens/tenant/History"));
const Profile = L(() => import("./screens/tenant/Profile"));

const Today = L(() => import("./screens/staff/Today"));

/* Rental management, notifications, statements and the QR ecosystem. */
const Settlement = L(() => import("./screens/owner/Settlement"));
const TenantLease = L(() => import("./screens/tenant/Lease"));
const Recurring = L(() => import("./screens/owner/Recurring"));
const Backup = L(() => import("./screens/owner/Backup"));
const Notifications = L(() => import("./screens/shared/Notifications"));
const Outbox = L(() => import("./screens/shared/Outbox"));
const Statements = L(() => import("./screens/tools/Statements"));
const QrCodes = L(() => import("./screens/tools/QrCodes"));
const ScanUnit = L(() => import("./screens/shared/ScanUnit"));
const VerifyReceipt = L(() => import("./screens/public/VerifyReceipt"));
const Units = L(() => import("./screens/staff/Units"));

/* Advanced tools: the real screen when its flag is on, otherwise the locked "Coming soon" preview. */
const Receipts = L(() =>
  features.receipts ? import("./screens/tools/Documents") : import("./screens/tools/locked/Receipts"),
);
const Meters = L(() =>
  features.meterReadings ? import("./screens/tools/Meters") : import("./screens/tools/locked/Meters"),
);
const Automations = L(() =>
  features.automations ? import("./screens/tools/Automations") : import("./screens/tools/locked/Automations"),
);
const Reports = L(() =>
  features.reports ? import("./screens/tools/Reports") : import("./screens/tools/locked/Reports"),
);

function Splash() {
  return (
    <div className="splash" aria-busy="true" aria-label="Loading pOS">
      <img src="/icons/icon.svg" alt="" className="app-icon" width={76} height={76} />
    </div>
  );
}

function OfflineBar() {
  const t = useT();
  const waiting = useOutbox().length;
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true),
      off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  if (online) return null;
  return (
    <div className="offline" role="status">
      <I.wifiOff /> {t("You're offline")}
      {waiting > 0 && (
        <>
          {" · "}
          <Link to="/outbox">{t("{n} waiting to sync", { n: waiting })}</Link>
        </>
      )}
    </div>
  );
}

/** Tells the person when entries they saved offline have gone out (they may be on another screen by then). */
function OutboxSentToast() {
  const toast = useToast();
  useEffect(() => {
    const off = onOutboxSent((n) =>
      toast(n === 1 ? tr("Your saved entry was sent") : tr("{n} saved entries were sent", { n }), "cloudUp"),
    );
    return () => {
      off();
    };
  }, [toast]);
  return null;
}

function FullError({
  message,
  retry,
  title,
  showOfflineHint = true,
}: {
  message: string;
  retry: () => void;
  title?: string;
  showOfflineHint?: boolean;
}) {
  const offline = !navigator.onLine;
  const t = useT();
  return (
    <div className="welcome center-text" style={{ justifyContent: "center" }}>
      <div className="empty">
        <div className="em-ic">{offline ? <I.wifiOff /> : <I.alert />}</div>
        <h1>{t(offline ? "You're offline" : (title ?? "pOS couldn't start"))}</h1>
        <p>
          {t(
            offline && showOfflineHint
              ? "Connect to the internet to see the latest rent, payments and requests."
              : message,
          )}
        </p>
        <button className="btn md auto" onClick={retry}>
          {t("Try again")}
        </button>
      </div>
    </div>
  );
}

/** Catches render errors and failed lazy-loaded screens (an old tab after a new deploy) instead of showing a blank page. */
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <FullError
        title="Something went wrong"
        message="pOS hit an unexpected problem. Reloading usually fixes it."
        retry={() => window.location.reload()}
      />
    );
  }
}

function ownerTabs(d?: Dashboard): Tab[] {
  return [
    { to: "/", label: "Home", icon: "home", end: true },
    { to: "/rent", label: "Rent", icon: "rupee", badge: d?.awaiting.length },
    { to: "/tenants", label: "Tenants", icon: "people" },
    { to: "/requests", label: "Requests", icon: "wrench", badge: d?.openRequestCount },
    { to: "/more", label: "More", icon: "more" },
  ];
}
const TENANT_TABS: Tab[] = [
  { to: "/", label: "Home", icon: "home", end: true },
  { to: "/history", label: "History", icon: "clock" },
  { to: "/requests", label: "Requests", icon: "wrench" },
  { to: "/profile", label: "Profile", icon: "person" },
];
const STAFF_TABS: Tab[] = [
  { to: "/", label: "Today", icon: "home", end: true },
  { to: "/requests", label: "Requests", icon: "wrench" },
  { to: "/units", label: "Units", icon: "building" },
  ...(features.meterReadings ? [{ to: "/meters", label: "Meters", icon: "gauge" } as Tab] : []),
  { to: "/expenses", label: "Expenses", icon: "wallet" },
];

/** Hides the tab bar on pushed detail screens, like iOS. */
function useShowTabs() {
  const { pathname } = useLocation();
  return (
    !/^\/(requests|tenants)\/\d+/.test(pathname) &&
    !/^\/(join|settings|notifications|outbox|u|verify|lease|statements)(\/|$)/.test(pathname) &&
    !/^\/more\/(recurring|backup|statements|qr)/.test(pathname)
  );
}

function OwnerApp() {
  const { data } = useApi<Dashboard>("/api/dashboard");
  const show = useShowTabs();
  return (
    <>
      <Suspense fallback={<SkeletonPage />}>
        <Routes>
          <Route path="/" element={<OwnerHome />} />
          <Route path="/rent" element={<Rent />} />
          <Route path="/tenants" element={<Tenants />} />
          <Route path="/tenants/:id" element={<TenantDetail />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/requests/:id" element={<RequestDetail />} />
          <Route path="/more" element={<More />} />
          <Route path="/more/properties" element={<Properties />} />
          <Route path="/more/expenses" element={<Expenses />} />
          <Route path="/more/invites" element={<Invites />} />
          <Route path="/more/receipts" element={<Receipts />} />
          <Route path="/more/meters" element={<Meters />} />
          <Route path="/more/automations" element={<Automations />} />
          <Route path="/more/reports" element={<Reports />} />
          <Route path="/tenants/:id/settlement" element={<Settlement />} />
          <Route path="/more/recurring" element={<Recurring />} />
          <Route path="/more/backup" element={<Backup />} />
          <Route path="/more/statements" element={<Statements />} />
          <Route path="/more/qr" element={<QrCodes />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/outbox" element={<Outbox />} />
          <Route path="/u/:code" element={<ScanUnit />} />
          <Route path="/verify" element={<VerifyReceipt />} />
          <Route path="/verify/:code" element={<VerifyReceipt />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/join/:token" element={<Join />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {show && <TabBar tabs={ownerTabs(data)} />}
      <QuickSearch />
    </>
  );
}

function TenantApp() {
  const show = useShowTabs();
  return (
    <>
      <Suspense fallback={<SkeletonPage />}>
        <Routes>
          <Route path="/" element={<TenantHome />} />
          <Route path="/history" element={<History />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/requests/:id" element={<RequestDetail />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/lease" element={<TenantLease />} />
          <Route path="/statements" element={<Statements />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/outbox" element={<Outbox />} />
          <Route path="/u/:code" element={<ScanUnit />} />
          <Route path="/verify" element={<VerifyReceipt />} />
          <Route path="/verify/:code" element={<VerifyReceipt />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/join/:token" element={<Join />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {show && <TabBar tabs={TENANT_TABS} />}
      <QuickSearch />
    </>
  );
}

function StaffApp() {
  const show = useShowTabs();
  return (
    <>
      <Suspense fallback={<SkeletonPage />}>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/requests/:id" element={<RequestDetail />} />
          <Route path="/units" element={<Units />} />
          <Route path="/tenants/:id" element={<TenantDetail />} />
          {features.meterReadings && <Route path="/meters" element={<Meters />} />}
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/outbox" element={<Outbox />} />
          <Route path="/u/:code" element={<ScanUnit />} />
          <Route path="/verify" element={<VerifyReceipt />} />
          <Route path="/verify/:code" element={<VerifyReceipt />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/join/:token" element={<Join />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      {show && <TabBar tabs={STAFF_TABS} />}
      <QuickSearch />
    </>
  );
}

function Gate() {
  const { status, me, error, recovery, refresh } = useAuth();
  const { pathname } = useLocation();
  if (status === "loading") return <Splash />;
  if (status === "signOutPending")
    return (
      <FullError
        message="Sign-out is pending. Connect and try again to finish signing out."
        retry={refresh}
        showOfflineHint={false}
      />
    );
  if (status === "error") return <FullError message={error} retry={refresh} />;
  if (recovery)
    return (
      <Suspense fallback={<Splash />}>
        <ResetPassword />
      </Suspense>
    );

  // An invitee who signed in elsewhere (Google redirect, email confirmation) resumes their invite.
  const pending = readPendingInvite();
  if (status !== "ready" && pending && !pathname.startsWith("/join/"))
    return <Navigate to={`/join/${pending.token}`} replace />;

  if (status === "signedOut" || status === "setup") {
    return (
      <Suspense fallback={<Splash />}>
        <Routes>
          <Route path="/join/:token" element={<Join />} />
          <Route path="/verify" element={<VerifyReceipt />} />
          <Route path="/verify/:code" element={<VerifyReceipt />} />
          <Route path="/u/:code" element={<ScanUnit />} />
          <Route path="*" element={status === "signedOut" ? <Welcome /> : <Onboarding />} />
        </Routes>
      </Suspense>
    );
  }
  const role = me?.profile?.role;
  if (role === "tenant") return <TenantApp />;
  if (role === "staff") return <StaffApp />;
  return <OwnerApp />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <div className="app">
            <OfflineBar />
            <OutboxSentToast />
            <ErrorBoundary>
              <Gate />
            </ErrorBoundary>
          </div>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
