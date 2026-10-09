import {
  ArrowUpCircle,
  BookOpen,
  CircleAlert,
  CopyX,
  Database,
  Download,
  FolderInput,
  Gauge,
  KeyRound,
  LogOut,
  Menu,
  Moon,
  Music2,
  Radio,
  RefreshCw,
  Settings,
  Shield,
  Sparkles,
  Sun,
  Trash2,
  Wand2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import type { AuthInfo, LibraryStats } from "../shared/types";
import { api } from "./api";
import { BrandLogo, MessageScreen, VersionFooter } from "./components/common";
import { Spinner } from "./components/ui";
import { LiveContext, useLive, useLiveState } from "./lib/events";
import { navigate, routeHref, useRoute, type PageId } from "./lib/router";
import { useTheme } from "./lib/theme";
import { CleanupPage } from "./pages/CleanupPage";
import { ConvertPage } from "./pages/ConvertPage";
import { DashboardPage } from "./pages/DashboardPage";
import { UnindexedPage } from "./pages/DiagnosticsPage";
import { DiscoverPage } from "./pages/DiscoverPage";
import { DownloadsPage } from "./pages/DownloadsPage";
import { DuplicatesPage } from "./pages/DuplicatesPage";
import { FollowingPage } from "./pages/FollowingPage";
import { GuidePage } from "./pages/GuidePage";
import { LibraryPage } from "./pages/LibraryPage";
import { OrganizePage } from "./pages/OrganizePage";
import { SettingsPage } from "./pages/SettingsPage";
import { TrashPage } from "./pages/TrashPage";
import { UpgradesPage } from "./pages/UpgradesPage";
import { scanProgress } from "./scan-progress";

type NavItem = {
  id: PageId;
  label: string;
  icon: typeof Gauge;
  subtitle: string;
  advanced?: boolean;
};

const navGroups: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [{ id: "dashboard", label: "Dashboard", icon: Gauge, subtitle: "Library health, scans, and what needs attention" }]
  },
  {
    label: "Library",
    items: [
      { id: "library", label: "Library", icon: Database, subtitle: "Browse artists, albums, and tracks on disk" },
      { id: "organize", label: "Organize", icon: FolderInput, subtitle: "Confirm identities and move files into the standard layout" },
      { id: "duplicates", label: "Duplicates", icon: CopyX, subtitle: "Keep the best copy of each track" },
      { id: "upgrades", label: "Upgrades", icon: ArrowUpCircle, subtitle: "Replace low-bitrate files with better copies" }
    ]
  },
  {
    label: "Get music",
    items: [
      { id: "discover", label: "Discover", icon: Music2, subtitle: "Search MusicBrainz and request albums or tracks" },
      { id: "downloads", label: "Downloads", icon: Download, subtitle: "Queue, review held matches, and wanted tracks" },
      { id: "following", label: "Following", icon: Radio, subtitle: "Artists you follow and their new releases" }
    ]
  },
  {
    label: "Maintenance",
    items: [
      { id: "cleanup", label: "Cleanup", icon: Wand2, subtitle: "Empty folders and non-music files" },
      { id: "convert", label: "Convert", icon: RefreshCw, subtitle: "Convert audio between formats" },
      { id: "trash", label: "Trash", icon: Trash2, subtitle: "Restore or permanently remove recycled files" }
    ]
  },
  {
    label: "System",
    items: [
      { id: "settings", label: "Settings", icon: Settings, subtitle: "Connections, identification, downloads, and library" },
      { id: "guide", label: "Guide", icon: BookOpen, subtitle: "How scanning, organizing, and downloading fit together" },
      { id: "diagnostics", label: "Diagnostics", icon: CircleAlert, subtitle: "Files the Navidrome index could not match", advanced: true }
    ]
  }
];

export default function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    api<AuthInfo>("/auth/me")
      .then(setAuth)
      .catch((caught) => setError((caught as Error).message));
  }, []);

  if (error) {
    return <MessageScreen title="NaviClean" message={error} />;
  }

  if (!auth) {
    return <MessageScreen title="NaviClean" message="Loading" />;
  }

  if (auth.authEnabled && !auth.authenticated) {
    return <LoginScreen onLogin={setAuth} />;
  }

  if (auth.mustChangePassword) {
    return <ChangePasswordScreen auth={auth} onChanged={setAuth} />;
  }

  return <Shell auth={auth} onAuthChange={setAuth} theme={theme} onThemeChange={setTheme} />;
}

function Shell({
  auth,
  onAuthChange,
  theme,
  onThemeChange
}: {
  auth: AuthInfo;
  onAuthChange: (auth: AuthInfo) => void;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}) {
  const route = useRoute();
  const live = useLiveState(true);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const refreshStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      setStats(await api<LibraryStats>("/stats"));
    } catch {
      // The dashboard shows its own error state; keep the last known numbers.
    } finally {
      setStatsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats, live.catalogVersion]);

  const items = useMemo(
    () => navGroups.flatMap((group) => group.items).filter((item) => !item.advanced || auth.advancedDiagnosticsEnabled),
    [auth.advancedDiagnosticsEnabled]
  );
  const page = items.some((item) => item.id === route.page) ? route.page : "dashboard";
  const active = items.find((item) => item.id === page) ?? items[0];

  useEffect(() => {
    setMobileNavOpen(false);
    document.title = page === "dashboard" ? "NaviClean" : `${active.label} · NaviClean`;
  }, [page, active.label]);

  const badges: Partial<Record<PageId, { count: number; tone: "attention" | "info" }>> = {
    organize: stats?.workflow.metadataReview ? { count: stats.workflow.metadataReview, tone: "attention" } : undefined,
    downloads: live.engine?.reviewCount
      ? { count: live.engine.reviewCount, tone: "attention" }
      : live.engine?.activeJobs
        ? { count: live.engine.activeJobs, tone: "info" }
        : undefined,
    following: live.engine?.newReleaseCount ? { count: live.engine.newReleaseCount, tone: "info" } : undefined
  };

  const signOut = async () => {
    await api<{ ok: boolean }>("/auth/logout", { method: "POST" }).catch(() => undefined);
    onAuthChange({ ...auth, authenticated: false, username: null, mustChangePassword: false });
  };

  const goSettings = () => navigate("settings");

  return (
    <LiveContext.Provider value={live}>
      <div className="app-shell">
        {mobileNavOpen && (
          <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />
        )}
        <aside className={`sidebar ${mobileNavOpen ? "open" : ""}`}>
          <div className="brand">
            <BrandLogo />
            <div>
              <strong>NaviClean</strong>
              <span>{auth.authEnabled ? auth.username : "Sign-in disabled"}</span>
            </div>
            <button className="mobile-nav-close" type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>
              <X size={20} />
            </button>
          </div>

          <nav className="nav-groups" aria-label="Main">
            {navGroups.map((group) => {
              const groupItems = group.items.filter((item) => !item.advanced || auth.advancedDiagnosticsEnabled);
              return (
                <div className="nav-group" key={group.label}>
                  <span className="nav-group-label">{group.label}</span>
                  {groupItems.map((item) => {
                    const Icon = item.icon;
                    const badge = badges[item.id];
                    return (
                      <a
                        key={item.id}
                        href={routeHref(item.id)}
                        className={`nav-link ${page === item.id ? "active" : ""}`}
                        aria-current={page === item.id ? "page" : undefined}
                      >
                        <Icon size={18} />
                        <span>{item.label}</span>
                        {badge && <span className={`nav-badge ${badge.tone}`}>{badge.count > 99 ? "99+" : badge.count}</span>}
                      </a>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          <div className="sidebar-footer">
            <button className="ghost-button" type="button" onClick={() => onThemeChange(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
              <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
            </button>
            {auth.authEnabled && (
              <button className="ghost-button" type="button" onClick={() => void signOut()}>
                <LogOut size={18} />
                <span>Sign out</span>
              </button>
            )}
            <VersionFooter />
          </div>
        </aside>

        <main className="main-panel">
          <header className="topbar">
            <button className="mobile-nav-toggle" type="button" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>
              <Menu size={20} />
            </button>
            <div className="topbar-title">
              <h1>{page === "dashboard" ? "Library overview" : active.label}</h1>
              <span className="topbar-subtitle">{active.subtitle}</span>
            </div>
            <ActivityIndicators />
          </header>

          <div className="page-body" key={page}>
            {page === "dashboard" && <DashboardPage stats={stats} statsLoading={statsLoading} onRefreshStats={refreshStats} />}
            {page === "library" && <LibraryPage onChanged={refreshStats} />}
            {page === "organize" && <OrganizePage stats={stats} onChanged={refreshStats} />}
            {page === "duplicates" && (
              <DuplicatesPage stats={stats} onChanged={refreshStats} onOpenOrganize={() => navigate("organize")} />
            )}
            {page === "upgrades" && <UpgradesPage />}
            {page === "discover" && <DiscoverPage route={route} onOpenSettings={goSettings} />}
            {page === "downloads" && <DownloadsPage route={route} />}
            {page === "following" && <FollowingPage />}
            {page === "cleanup" && <CleanupPage route={route} onOpenSettings={goSettings} />}
            {page === "convert" && <ConvertPage onChanged={refreshStats} />}
            {page === "trash" && <TrashPage />}
            {page === "settings" && <SettingsPage auth={auth} onAuthChange={onAuthChange} />}
            {page === "guide" && <GuidePage />}
            {page === "diagnostics" && auth.advancedDiagnosticsEnabled && (
              <UnindexedPage lastScanFinishedAt={stats?.lastScanFinishedAt ?? null} onChanged={refreshStats} />
            )}
          </div>
        </main>
      </div>
    </LiveContext.Provider>
  );
}

/** Compact live status for scans and downloads, visible on every page. */
function ActivityIndicators() {
  const live = useLive();
  const progress = scanProgress(live.scan, null);
  const activeJobs = live.engine?.activeJobs ?? 0;
  const reviewCount = live.engine?.reviewCount ?? 0;
  const chips: ReactNode[] = [];

  if (live.scan?.running) {
    chips.push(
      <a className="activity-chip running" href={routeHref("dashboard")} key="scan" title={progress.detail}>
        <Spinner size={14} />
        <span>Scanning{progress.percent !== null ? ` ${Math.round(progress.percent)}%` : ""}</span>
      </a>
    );
  }
  if (activeJobs > 0) {
    chips.push(
      <a className="activity-chip running" href={routeHref("downloads")} key="downloads">
        <Download size={14} />
        <span>{activeJobs} downloading</span>
      </a>
    );
  }
  if (reviewCount > 0) {
    chips.push(
      <a className="activity-chip attention" href={routeHref("downloads", { tab: "review" })} key="review">
        <Sparkles size={14} />
        <span>{reviewCount} to review</span>
      </a>
    );
  }

  return (
    <div className="topbar-actions">
      {chips}
      <span
        className={`live-dot ${live.connected ? "connected" : ""}`}
        title={live.connected ? "Live updates connected" : "Reconnecting to live updates"}
        aria-label={live.connected ? "Live updates connected" : "Reconnecting"}
      />
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (auth: AuthInfo) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      onLogin(await api<AuthInfo>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-layout">
      <form className="auth-panel" onSubmit={submit}>
        <div className="brand auth-brand">
          <BrandLogo />
          <div>
            <strong>NaviClean</strong>
            <span>Library cleaner and music engine for Navidrome</span>
          </div>
        </div>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus />
        </label>
        <label>
          Password
          <input value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" type="password" />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button full" type="submit" disabled={busy || !username || !password}>
          {busy ? <Spinner size={18} /> : <Shield size={18} />}
          <span>Sign in</span>
        </button>
        <p className="auth-hint">First run? Sign in with the default admin account; you will be asked to choose a new password.</p>
      </form>
    </main>
  );
}

function ChangePasswordScreen({ auth, onChanged }: { auth: AuthInfo; onChanged: (auth: AuthInfo) => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onChanged(await api<AuthInfo>("/auth/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword })
      }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-layout">
      <form className="auth-panel" onSubmit={submit}>
        <div className="brand auth-brand">
          <BrandLogo />
          <div>
            <strong>Choose a new password</strong>
            <span>{auth.username} is still using the default password</span>
          </div>
        </div>
        <p className="auth-hint">
          NaviClean can move, retag, and recycle your music files, so the shipped admin/admin password has to be replaced before you continue.
        </p>
        <label>
          Current password
          <input value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} type="password" autoComplete="current-password" autoFocus />
        </label>
        <label>
          New password
          <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" autoComplete="new-password" minLength={8} />
        </label>
        <label>
          Confirm new password
          <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" />
        </label>
        {mismatch && <p className="form-error">The new passwords do not match.</p>}
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button full" type="submit" disabled={busy || !currentPassword || newPassword.length < 8 || mismatch}>
          {busy ? <Spinner size={18} /> : <KeyRound size={18} />}
          <span>Save password</span>
        </button>
      </form>
    </main>
  );
}
