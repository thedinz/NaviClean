import {
  Activity,
  Album as AlbumIcon,
  BookOpen,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CopyX,
  Database,
  Download,
  ExternalLink,
  FileQuestion,
  FolderInput,
  FolderX,
  Gauge,
  ListChecks,
  Loader2,
  LockKeyhole,
  LogOut,
  Moon,
  Music2,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Sun,
  Trash2,
  Undo2,
  UserRound
} from "lucide-react";
import { Fragment, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AudioConvertExtensionGroup,
  AudioConvertFile,
  AudioConvertJob,
  AudioConvertQuality,
  AudioConvertTargetFormat,
  AudioConvertView,
  AuthInfo,
  DuplicateBulkResolveResult,
  EmptyFolderDeleteResult,
  EmptyFolderExcludeResult,
  EmptyFolderItem,
  EmptyFolderPreview,
  DuplicateGroup,
  LibraryAlbumSummary,
  LibraryArtistSummary,
  LibraryStats,
  LibraryTrashResult,
  NavidromeScanStatus,
  NonMusicFileClassification,
  NonMusicFileGroup,
  NonMusicFileGroupDetail,
  NonMusicFileItem,
  NonMusicFileTrashResult,
  NonMusicTrashResult,
  NonMusicFilesView,
  OrganizeApplyResult,
  OrganizeCollisionCandidate,
  OrganizePlan,
  OrganizeTrashResult,
  OrganizeTrashSelection,
  RecycleBinDeleteResult,
  RecycleBinItem,
  RecycleBinRestoreResult,
  RecycleBinView,
  ScanStatus,
  SettingsView,
  SpotifyAlbumDetail,
  SpotifyArtistDiscography,
  SpotifyArtistSummary,
  SpotifyCatalogDownloadJob,
  SpotifyCatalogDownloadPreviewResult,
  TrackFile,
  UnindexedFilesView,
  UnindexedNavidromeCandidate,
  UnindexedNavidromeLookupResult,
  UnindexedTrashResult
} from "../shared/types";
import { api } from "./api";
import { appVersion } from "./version";

type Page = "dashboard" | "instructions" | "library" | "empty-folders" | "non-music" | "unindexed" | "discover" | "organize" | "convert" | "duplicates" | "trash" | "settings";
type AppTheme = "light" | "dark";
type UnindexedFilter = "all" | "possible-stale-scan" | "no-api-match";
type OrganizePreviewFilter = "attention" | "ready" | "duplicate-target" | "conflict" | "missing" | "spotifybu" | "same" | "all";
type OrganizePreviewItem = OrganizePlan["items"][number];

const libraryArtistPageSize = 25;
const unindexedPageSize = 150;
const organizePreviewPageSize = 150;
const providerPreviewBatchSize = 6;
const themeStorageKey = "naviclean-theme";
const navicleanIssuesUrl = "https://github.com/thedinz/NaviClean/issues/new";
const trashAudioExtensions = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".ape",
  ".dff",
  ".dsf",
  ".flac",
  ".m4a",
  ".mka",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".wma"
]);
const trashArtworkExtensions = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
const trashPlaylistExtensions = new Set([".m3u", ".m3u8", ".pls", ".xspf"]);
const trashLyricsExtensions = new Set([".lrc"]);
const trashMetadataExtensions = new Set([
  ".accurip",
  ".cue",
  ".log",
  ".md5",
  ".nfo",
  ".pdf",
  ".sfv",
  ".sha1",
  ".sha256",
  ".txt",
  ".url"
]);
const trashArchiveExtensions = new Set([".7z", ".gz", ".rar", ".tar", ".zip"]);
const trashVideoExtensions = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"]);
const trashJunkExtensions = new Set([".bak", ".crdownload", ".part", ".tmp"]);

type NavItem = { id: Page; label: string; icon: typeof Gauge; advancedDiagnostics?: boolean };

const navItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "instructions", label: "Instructions", icon: BookOpen },
  { id: "library", label: "Library", icon: Database },
  { id: "empty-folders", label: "Empty Folders", icon: FolderX },
  { id: "non-music", label: "Non-Music Files", icon: FileQuestion },
  { id: "unindexed", label: "Diagnostics", icon: CircleAlert, advancedDiagnostics: true },
  { id: "discover", label: "Discover", icon: Music2 },
  { id: "organize", label: "Organize", icon: FolderInput },
  { id: "convert", label: "Convert", icon: RefreshCw },
  { id: "duplicates", label: "Duplicates", icon: CopyX },
  { id: "trash", label: "Trash", icon: Trash2 },
  { id: "settings", label: "Settings", icon: Settings }
];

const organizePreviewFilters: Array<{ id: OrganizePreviewFilter; label: string }> = [
  { id: "attention", label: "Needs action" },
  { id: "ready", label: "Ready" },
  { id: "duplicate-target", label: "Duplicates" },
  { id: "conflict", label: "Conflicts" },
  { id: "missing", label: "Missing" },
  { id: "spotifybu", label: "SpotifyBU" },
  { id: "same", label: "Organized" },
  { id: "all", label: "All" }
];

const unindexedFilters: Array<{ id: UnindexedFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "possible-stale-scan", label: "Organized" },
  { id: "no-api-match", label: "No match" }
];

const audioConvertTargetOptions: Array<{
  id: AudioConvertTargetFormat;
  extension: string;
  label: string;
  description: string;
  lossless: boolean;
}> = [
  { id: "mp3", extension: ".mp3", label: "MP3", description: "Maximum compatibility", lossless: false },
  { id: "m4a", extension: ".m4a", label: "M4A / AAC", description: "Efficient Apple-friendly audio", lossless: false },
  { id: "opus", extension: ".opus", label: "Opus", description: "Efficient modern audio", lossless: false },
  { id: "ogg", extension: ".ogg", label: "OGG Vorbis", description: "Open lossy audio", lossless: false },
  { id: "flac", extension: ".flac", label: "FLAC", description: "Lossless archive format", lossless: true },
  { id: "wav", extension: ".wav", label: "WAV", description: "Uncompressed PCM", lossless: true }
];

const audioConvertLossyQualityOptions: Array<{ id: AudioConvertQuality; label: string; description: string }> = [
  { id: "128k", label: "128 kbps", description: "Smaller files" },
  { id: "192k", label: "192 kbps", description: "Balanced" },
  { id: "256k", label: "256 kbps", description: "High quality" },
  { id: "320k", label: "320 kbps", description: "Highest common bitrate" }
];

const audioConvertLosslessQualityOption = {
  id: "lossless" as const,
  label: "Lossless",
  description: "No target bitrate"
};

export default function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<AppTheme>(() => initialTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Theme still applies for the current session.
    }
  }, [theme]);

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
  theme: AppTheme;
  onThemeChange: (theme: AppTheme) => void;
}) {
  const [page, setPage] = useState<Page>("dashboard");
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [navidromeScan, setNavidromeScan] = useState<NavidromeScanStatus | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [navidromeScanBusy, setNavidromeScanBusy] = useState<"quick" | "full" | null>(null);
  const [signOutBusy, setSignOutBusy] = useState(false);

  const loadScanStatus = async () => {
    const nextScan = await api<ScanStatus>("/scan/status");
    setScan(nextScan);
    return nextScan;
  };

  const loadNavidromeScanStatus = async () => {
    const nextScan = await api<NavidromeScanStatus>("/navidrome/scan/status");
    setNavidromeScan(nextScan);
    return nextScan;
  };

  const loadStats = async () => {
    setStatsLoading(true);

    try {
      const nextStats = await api<LibraryStats>("/stats");
      setStats(nextStats);
      return nextStats;
    } finally {
      setStatsLoading(false);
    }
  };

  const refreshStats = async () => {
    const nextScan = await loadScanStatus();

    if (!nextScan.running) {
      await loadStats();
      return;
    }

    setStatsLoading(false);
  };

  useEffect(() => {
    refreshStats().catch((caught) => {
      setStatsLoading(false);
      setNotice((caught as Error).message);
    });
    loadNavidromeScanStatus().catch((caught) => {
      setNotice((caught as Error).message);
    });
  }, []);

  useEffect(() => {
    if (!scan?.running) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      loadScanStatus()
        .then((nextScan) => {
          if (!nextScan.running) {
            return loadStats();
          }
          return null;
        })
        .catch((caught) => {
          setStatsLoading(false);
          setNotice((caught as Error).message);
        });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [scan?.running]);

  useEffect(() => {
    if (!navidromeScan?.running) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      loadNavidromeScanStatus().catch((caught) => {
        setNotice((caught as Error).message);
      });
    }, 1500);
    return () => window.clearInterval(interval);
  }, [navidromeScan?.running]);

  const startScan = async () => {
    setNotice(null);
    setScanBusy(true);

    try {
      const next = await api<ScanStatus>("/scan/start", { method: "POST" });
      setScan(next);

      if (!next.running) {
        await loadStats();
      }
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setScanBusy(false);
    }
  };

  const startNavidromeScanAction = async (fullScan: boolean) => {
    setNotice(null);
    setNavidromeScanBusy(fullScan ? "full" : "quick");

    try {
      const next = await api<NavidromeScanStatus>("/navidrome/scan/start", {
        method: "POST",
        body: JSON.stringify({ fullScan })
      });
      setNavidromeScan(next);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setNavidromeScanBusy(null);
    }
  };

  const signOut = async () => {
    setSignOutBusy(true);
    setNotice(null);

    try {
      await api<{ ok: boolean }>("/auth/logout", { method: "POST" });
      onAuthChange({
        advancedDiagnosticsEnabled: auth.advancedDiagnosticsEnabled,
        authEnabled: true,
        authenticated: false,
        username: null
      });
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setSignOutBusy(false);
    }
  };

  const toggleTheme = () => {
    onThemeChange(theme === "dark" ? "light" : "dark");
  };

  const visibleNavItems = useMemo(
    () => navItems.filter((item) => !item.advancedDiagnostics || auth.advancedDiagnosticsEnabled),
    [auth.advancedDiagnosticsEnabled]
  );

  useEffect(() => {
    if (page === "unindexed" && !auth.advancedDiagnosticsEnabled) {
      setPage("dashboard");
    }
  }, [auth.advancedDiagnosticsEnabled, page]);

  const active = visibleNavItems.find((item) => item.id === page) || visibleNavItems[0];
  const ThemeIcon = theme === "dark" ? Sun : Moon;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">NC</div>
          <div>
            <strong>NaviClean</strong>
            <span>{auth.authEnabled ? auth.username : "Auth off"}</span>
          </div>
        </div>

        <nav className="nav-list">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={page === item.id ? "active" : ""}
                type="button"
                onClick={() => setPage(item.id)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={toggleTheme}
            aria-pressed={theme === "dark"}
            title={theme === "dark" ? "Use light mode" : "Use dark mode"}
          >
            <ThemeIcon size={18} />
            <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <button className="ghost-button" type="button" onClick={signOut} disabled={signOutBusy} title="Sign out">
            {signOutBusy ? <Loader2 className="spin" size={18} /> : <LogOut size={18} />}
            <span>{signOutBusy ? "Signing out" : "Sign out"}</span>
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">{active.label}</span>
            <h1>{active.label === "Dashboard" ? "Library Console" : active.label}</h1>
          </div>
          <div className="topbar-actions">
            {notice && <span className="notice">{notice}</span>}
            <button className="primary-button" type="button" onClick={startScan} disabled={scanBusy || scan?.running} title="Scan NaviClean catalog">
              {scanBusy || scan?.running ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              <span>{scanBusy || scan?.running ? "Scanning" : "NaviClean scan"}</span>
            </button>
          </div>
        </header>

        <div className="notice-bar safety app-risk-banner" role="note">
          <CircleAlert size={18} aria-hidden="true" />
          <div>
            <strong>Whole-library caution</strong>
            <span>
              NaviClean sorting is improving on a near daily basis. Review previews and backups before applying changes
              across an entire library; use whole-library cleanup at your own risk.
            </span>
          </div>
        </div>

        {page === "dashboard" && (
          <Dashboard
            stats={stats}
            statsLoading={statsLoading}
            scan={scan}
            scanBusy={scanBusy}
            navidromeScan={navidromeScan}
            navidromeScanBusy={navidromeScanBusy}
            onScan={startScan}
            onNavidromeScan={startNavidromeScanAction}
          />
        )}
        {page === "instructions" && <InstructionsPage />}
        {page === "library" && <LibraryPage onChanged={refreshStats} />}
        {page === "empty-folders" && <EmptyFoldersPage />}
        {page === "non-music" && <NonMusicFilesPage />}
        {auth.advancedDiagnosticsEnabled && page === "unindexed" && (
          <UnindexedPage lastScanFinishedAt={stats?.lastScanFinishedAt ?? null} onChanged={refreshStats} />
        )}
        {page === "discover" && <DiscoverPage />}
        {page === "duplicates" && (
          <DuplicatesPage stats={stats} onChanged={refreshStats} onOpenOrganize={() => setPage("organize")} />
        )}
        {page === "organize" && <OrganizePage stats={stats} onChanged={refreshStats} />}
        {page === "convert" && <ConvertPage onChanged={refreshStats} />}
        {page === "trash" && <TrashPage />}
        {page === "settings" && (
          <SettingsPage advancedDiagnosticsEnabled={auth.advancedDiagnosticsEnabled} onAuthChange={onAuthChange} />
        )}
        <VersionFooter />
      </main>
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (auth: AuthInfo) => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      onLogin(await api<AuthInfo>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password })
      }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-layout">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand login-brand">
          <div className="brand-mark">NC</div>
          <div>
            <strong>NaviClean</strong>
            <span>Library Console</span>
          </div>
        </div>
        <label>
          Username
          <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            type="password"
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button full" type="submit" disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <Shield size={18} />}
          <span>Sign in</span>
        </button>
      </form>
    </main>
  );
}

function Dashboard({
  stats,
  statsLoading,
  scan,
  scanBusy,
  navidromeScan,
  navidromeScanBusy,
  onScan,
  onNavidromeScan
}: {
  stats: LibraryStats | null;
  statsLoading: boolean;
  scan: ScanStatus | null;
  scanBusy: boolean;
  navidromeScan: NavidromeScanStatus | null;
  navidromeScanBusy: "quick" | "full" | null;
  onScan: () => Promise<void>;
  onNavidromeScan: (fullScan: boolean) => Promise<void>;
}) {
  const metrics = [
    { label: "Tracks", value: stats?.totalTracks ?? null, tone: "teal" },
    { label: "Duplicate groups", value: stats?.duplicateGroups ?? null, tone: "rose" },
    { label: "Pending moves", value: stats?.pendingMoves ?? null, tone: "amber" },
    { label: "Metadata flags", value: stats?.missingMetadata ?? null, tone: "ink" }
  ];
  const scanRunning = Boolean(scan?.running);
  const scanRequired = Boolean(stats && !stats.workflow.scanned && !scanRunning);
  const statsPending = !scanRunning && !scanRequired && (statsLoading || !stats);
  const metricMode = scanRunning && !stats ? "scanning" : statsPending ? "loading" : scanRequired ? "scan-needed" : "value";
  const navidromeStatusLoading = !navidromeScan;
  const navidromeConfigured = Boolean(navidromeScan?.configured);
  const navidromeRunning = Boolean(navidromeScan?.running);
  const navidromeControlsDisabled = navidromeStatusLoading || !navidromeConfigured || navidromeRunning || Boolean(navidromeScanBusy);
  const navidromeStatusLabel = navidromeStatusLoading
    ? "Loading"
    : !navidromeConfigured
    ? "Not configured"
    : navidromeRunning
    ? "Running"
    : "Idle";

  return (
    <section className="content-grid">
      <div className="metric-grid">
        {metrics.map((metric) => (
          <article className={`metric-card ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            {metricMode === "loading" ? (
              <strong className="metric-loading">
                <Loader2 className="spin" size={22} />
                <span>Loading</span>
              </strong>
            ) : metricMode === "scanning" ? (
              <strong className="metric-loading">
                <Loader2 className="spin" size={22} />
                <span>Scanning</span>
              </strong>
            ) : metricMode === "scan-needed" ? (
              <strong className="metric-empty">Scan needed</strong>
            ) : (
              <strong>{(metric.value ?? 0).toLocaleString()}</strong>
            )}
          </article>
        ))}
      </div>
      {statsPending && (
        <ActionProgress label="Loading library totals, duplicate groups, pending moves, and metadata flags" />
      )}
      {scanRequired && (
        <div className="notice-bar safety fresh-scan-banner" role="status">
          <strong>Fresh scan needed</strong>
          <span>No saved scan data was found. Run a fresh scan to rebuild the Library Console totals.</span>
          <button className="primary-button" type="button" onClick={onScan} disabled={scanBusy || scanRunning}>
            {scanBusy || scanRunning ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{scanBusy || scanRunning ? "Scanning" : "Scan now"}</span>
          </button>
        </div>
      )}

      <article className="panel wide">
        <div className="panel-title">
          <Activity size={18} />
          <h2>Scan Status</h2>
        </div>
        <div className="status-row">
          <StatusPill active={Boolean(scan?.running)} label={scan?.running ? "Running" : "Idle"} />
          <span>{scan?.audioFiles.toLocaleString() || 0} audio files</span>
          <span>{scan?.scannedFiles.toLocaleString() || 0} scanned files</span>
          <span>{stats?.lastScanFinishedAt ? formatDate(stats.lastScanFinishedAt) : "No completed scan"}</span>
        </div>
        {scan?.running && <ActionProgress label="Scanning library" />}
        {scan?.warnings.length ? (
          <div className="notice-bar safety">
            <strong>Scan notes</strong>
            {scan.warnings.slice(0, 5).map((item) => (
              <span key={item}>{item}</span>
            ))}
            {scan.warnings.length > 5 && <span>{scan.warnings.length - 5} more notes</span>}
          </div>
        ) : null}
        {scan?.errors.length ? (
          <div className="error-list">
            {scan.errors.slice(0, 5).map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}
      </article>

      <article className="panel wide">
        <div className="panel-title">
          <Database size={18} />
          <h2>Navidrome Scan</h2>
        </div>
        <div className="scan-control-row">
          <button
            className="secondary-button"
            type="button"
            onClick={() => onNavidromeScan(false)}
            disabled={navidromeControlsDisabled}
            title="Start a quick Navidrome scan"
          >
            {navidromeScanBusy === "quick" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{navidromeScanBusy === "quick" ? "Starting" : "Quick scan"}</span>
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onNavidromeScan(true)}
            disabled={navidromeControlsDisabled}
            title="Start a full Navidrome scan"
          >
            {navidromeScanBusy === "full" ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
            <span>{navidromeScanBusy === "full" ? "Starting" : "Full scan"}</span>
          </button>
        </div>
        <div className="status-row">
          <StatusPill active={navidromeRunning} label={navidromeStatusLabel} />
          <span>{navidromeScanTypeLabel(navidromeScan?.scanType)}</span>
          <span>{(navidromeScan?.folderCount ?? 0).toLocaleString()} folders</span>
          <span>{(navidromeScan?.count ?? 0).toLocaleString()} files</span>
          <span>{navidromeScan?.lastScan ? formatScanDate(navidromeScan.lastScan) : "No completed scan"}</span>
          {typeof navidromeScan?.elapsedSeconds === "number" && (
            <span>{formatDuration(navidromeScan.elapsedSeconds)} elapsed</span>
          )}
        </div>
        {navidromeRunning && (
          <ActionProgress label={`${navidromeScanActionLabel(navidromeScan?.scanType)} running in Navidrome`} />
        )}
        {!navidromeStatusLoading && !navidromeConfigured && (
          <div className="notice-bar safety">
            <strong>Navidrome connection needed</strong>
            <span>Add Navidrome URL, username, and password in Settings to trigger scans from NaviClean.</span>
          </div>
        )}
        {navidromeScan?.error ? (
          <div className="error-list">
            <span>{navidromeScan.error}</span>
          </div>
        ) : null}
      </article>

      <article className="panel wide">
        <div className="panel-title">
          <ListChecks size={18} />
          <h2>Cleanup Stages</h2>
        </div>
        <div className="stage-row">
          <StagePill label="1 Scan" active={stats?.workflow.stage === "scan"} complete={Boolean(stats?.workflow.scanned)} />
          <StagePill label="2 Organize" active={stats?.workflow.stage === "organize"} complete={Boolean(stats?.workflow.duplicateScanReady)} />
          <StagePill label="3 Duplicates" active={stats?.workflow.stage === "duplicates"} complete={Boolean(stats?.workflow.duplicateScanReady)} />
        </div>
        <p className="stage-message">{stats?.workflow.message || "Scan the library to start cleanup."}</p>
      </article>
    </section>
  );
}

function InstructionsPage() {
  const scanTypes = [
    {
      title: "Navidrome Quick Scan",
      body: "Refreshes Navidrome's index using its normal change-detection shortcuts. Use it for routine updates after adding, removing, or retagging a small set of files."
    },
    {
      title: "Navidrome Full Scan",
      body: "Forces Navidrome to walk the library more thoroughly and ignore timestamp shortcuts. Use it after large moves, renamed folders, volume/path changes, stale matches, or anything that makes Navidrome's index look out of sync."
    },
    {
      title: "NaviClean Scan",
      body: "Reads the mounted library into NaviClean's catalog and enriches matches from Navidrome. Run it after the Navidrome scan finishes so organize, diagnostics, and duplicate cleanup use the newest library state."
    }
  ];
  const workflow = [
    "Run Navidrome Quick Scan for normal changes, or Navidrome Full Scan for major moves and stale-index problems.",
    "Wait for the Navidrome Scan panel to return to Idle.",
    "Run NaviClean Scan to rebuild NaviClean's catalog from the current files and Navidrome metadata.",
    "Review Organize, Duplicates, Diagnostics, and Trash actions.",
    "After applying moves or deleting files, run Navidrome Full Scan, wait for Idle, then run NaviClean Scan again."
  ];
  const scenarios = [
    {
      title: "New music was added",
      steps: "Navidrome Quick Scan, then NaviClean Scan."
    },
    {
      title: "A few tags changed",
      steps: "Navidrome Quick Scan, then NaviClean Scan."
    },
    {
      title: "NaviClean organized or moved files",
      steps: "Navidrome Full Scan, then NaviClean Scan."
    },
    {
      title: "Many folders were renamed outside NaviClean",
      steps: "Navidrome Full Scan, then NaviClean Scan."
    },
    {
      title: "Diagnostics show stale or missing Navidrome matches",
      steps: "Navidrome Full Scan first. If it settles cleanly, run NaviClean Scan."
    },
    {
      title: "Only NaviClean totals look old",
      steps: "Run NaviClean Scan. Use a Navidrome scan first only if Navidrome itself is stale."
    }
  ];

  return (
    <section className="content-grid instructions-page">
      <article className="panel wide">
        <div className="panel-title">
          <BookOpen size={18} />
          <h2>Scan Buttons</h2>
        </div>
        <div className="instruction-card-grid">
          {scanTypes.map((item) => (
            <div className="instruction-card" key={item.title}>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </div>
          ))}
        </div>
      </article>

      <article className="panel wide">
        <div className="panel-title">
          <ListChecks size={18} />
          <h2>Run Order</h2>
        </div>
        <ol className="instruction-flow">
          {workflow.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </article>

      <article className="panel wide">
        <div className="panel-title">
          <Activity size={18} />
          <h2>Common Scenarios</h2>
        </div>
        <div className="scenario-list">
          {scenarios.map((item) => (
            <div className="scenario-row" key={item.title}>
              <strong>{item.title}</strong>
              <span>{item.steps}</span>
            </div>
          ))}
        </div>
      </article>
    </section>
  );
}

function LibraryPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const [view, setView] = useState<"artists" | "albums" | "tracks">("artists");
  const [search, setSearch] = useState("");
  const [artists, setArtists] = useState<LibraryArtistSummary[]>([]);
  const [albums, setAlbums] = useState<LibraryAlbumSummary[]>([]);
  const [tracks, setTracks] = useState<TrackFile[]>([]);
  const [selectedArtist, setSelectedArtist] = useState<LibraryArtistSummary | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<LibraryAlbumSummary | null>(null);
  const [artistPage, setArtistPage] = useState(1);
  const [artistTotal, setArtistTotal] = useState(0);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const handle = window.setTimeout(() => {
      loadLibraryView(view, search, selectedArtist, selectedAlbum, artistPage)
        .then((body) => {
          if (cancelled) {
            return;
          }

          if (body.view === "artists") {
            setArtists(body.artists);
            setArtistPage(body.page);
            setArtistTotal(body.artistTotal);
            setCatalogTotal(body.total);
            setAlbums([]);
            setTracks([]);
          } else if (body.view === "albums") {
            setAlbums(body.albums);
            setTracks([]);
          } else {
            setTracks(body.tracks);
          }

          setError(null);
        })
        .catch((caught) => {
          if (!cancelled) {
            setError((caught as Error).message);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [view, search, selectedArtist, selectedAlbum, artistPage, reloadKey]);

  const openArtists = () => {
    setView("artists");
    setSelectedArtist(null);
    setSelectedAlbum(null);
    setSearch("");
    setArtistPage(1);
  };

  const openArtist = (artist: LibraryArtistSummary) => {
    setSelectedArtist(artist);
    setSelectedAlbum(null);
    setView("albums");
    setSearch("");
  };

  const openAlbum = (album: LibraryAlbumSummary) => {
    setSelectedAlbum(album);
    setView("tracks");
    setSearch("");
  };

  const updateSearch = (value: string) => {
    setSearch(value);

    if (view === "artists") {
      setArtistPage(1);
    }
  };

  const trashArtist = async (artist: LibraryArtistSummary) => {
    const confirmed = window.confirm(
      `Move ${artist.name}, ${artist.albumCount} ${pluralize("album", artist.albumCount)}, and ${artist.trackCount} ${pluralize("track", artist.trackCount)} to the recycle bin?`
    );

    if (!confirmed) {
      return;
    }

    await trashLibraryItem(`artist:${artist.id}`, `/library/artists/${artist.id}`, () => {
      if (selectedArtist?.id === artist.id) {
        openArtists();
      }
    });
  };

  const trashAlbum = async (album: LibraryAlbumSummary) => {
    const confirmed = window.confirm(
      `Move ${album.artist} - ${album.title} and ${album.trackCount} ${pluralize("track", album.trackCount)} to the recycle bin?`
    );

    if (!confirmed) {
      return;
    }

    await trashLibraryItem(`album:${album.id}`, `/library/artists/${album.artistId}/albums/${album.id}`, () => {
      if (selectedAlbum?.id === album.id) {
        setSelectedAlbum(null);
        setView("albums");
      }
    });
  };

  const trashTrack = async (track: TrackFile) => {
    const confirmed = window.confirm(`Move ${track.title} to the recycle bin?`);

    if (!confirmed) {
      return;
    }

    await trashLibraryItem(`track:${track.id}`, `/library/tracks/${track.id}`, () => {
      if (tracks.length <= 1) {
        setSelectedAlbum(null);
        setView("albums");
      }
    });
  };

  const trashLibraryItem = async (key: string, endpoint: string, afterTrash?: () => void) => {
    setBusyKey(key);
    setError(null);

    try {
      const result = await api<LibraryTrashResult>(endpoint, { method: "DELETE" });
      setNotice(libraryTrashNotice(result));

      if (result.trashed > 0) {
        afterTrash?.();
        await onChanged();
      }

      setReloadKey((current) => current + 1);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const artistPageCount = Math.max(1, Math.ceil(artistTotal / libraryArtistPageSize));
  const artistRangeStart = artistTotal === 0 ? 0 : (artistPage - 1) * libraryArtistPageSize + 1;
  const artistRangeEnd = artistTotal === 0 ? 0 : Math.min(artistTotal, artistRangeStart + artists.length - 1);
  const artistRangeLabel =
    artistTotal > libraryArtistPageSize
      ? `${artistRangeStart.toLocaleString()}-${artistRangeEnd.toLocaleString()} of ${artistTotal.toLocaleString()} ${pluralize("artist", artistTotal)}`
      : `${artistTotal.toLocaleString()} ${pluralize("artist", artistTotal)}`;
  const countLabel =
    view === "artists"
      ? `${artistRangeLabel} / ${catalogTotal.toLocaleString()} ${pluralize("track", catalogTotal)}`
      : view === "albums"
        ? `${albums.length.toLocaleString()} ${pluralize("album", albums.length)}`
        : `${tracks.length.toLocaleString()} ${pluralize("track", tracks.length)}`;

  return (
    <section className="panel library-browser">
      <div className="toolbar library-toolbar">
        <div className="library-breadcrumbs" aria-label="Library location">
          <button className={view === "artists" ? "active" : ""} type="button" onClick={openArtists}>
            Artists
          </button>
          {selectedArtist && (
            <button
              className={view === "albums" ? "active" : ""}
              type="button"
              onClick={() => {
                setSelectedAlbum(null);
                setView("albums");
                setSearch("");
              }}
            >
              {selectedArtist.name}
            </button>
          )}
          {selectedAlbum && (
            <button className="active" type="button" onClick={() => setView("tracks")}>
              {selectedAlbum.title}
            </button>
          )}
        </div>
        <div className="search-box">
          <Search size={17} />
          <input value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="Search" />
        </div>
        {view === "artists" && artistTotal > libraryArtistPageSize && (
          <div className="pagination-controls library-pagination" aria-label="Artist pages">
            <button
              className="icon-button"
              type="button"
              onClick={() => setArtistPage((current) => Math.max(1, current - 1))}
              disabled={artistPage <= 1}
              title="Previous artists"
            >
              <ChevronLeft size={18} />
            </button>
            <span>{artistRangeLabel}</span>
            <button
              className="icon-button"
              type="button"
              onClick={() => setArtistPage((current) => Math.min(artistPageCount, current + 1))}
              disabled={artistPage >= artistPageCount}
              title="Next artists"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        )}
        <span className="muted">{loading ? "Loading library" : countLabel}</span>
      </div>
      {notice && <p className="notice-bar">{notice}</p>}
      {loading && <ActionProgress label="Loading library" />}
      {error && <p className="form-error">{error}</p>}
      {!loading && view === "artists" && (
        <LibraryArtistGrid artists={artists} busyKey={busyKey} onOpen={openArtist} onTrash={trashArtist} />
      )}
      {!loading && view === "albums" && (
        <LibraryAlbumGrid albums={albums} busyKey={busyKey} onOpen={openAlbum} onTrash={trashAlbum} />
      )}
      {!loading && view === "tracks" && (
        <LibraryTrackTable tracks={tracks} busyKey={busyKey} onTrash={trashTrack} />
      )}
    </section>
  );
}

function EmptyFoldersPage() {
  const [preview, setPreview] = useState<EmptyFolderPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"load" | "delete" | "exclude" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const folders = preview?.folders || [];
  const selectedFolders = folders.filter((folder) => selectedIds[folder.id]);
  const allSelected = folders.length > 0 && selectedFolders.length === folders.length;

  const applyPreview = (next: EmptyFolderPreview) => {
    setPreview(next);
    setErrors(next.errors);
    setSelectedIds((current) => {
      const validIds = new Set(next.folders.map((folder) => folder.id));
      return Object.fromEntries(Object.entries(current).filter(([id, selected]) => selected && validIds.has(id)));
    });
  };

  const load = async ({ quiet = false }: { quiet?: boolean } = {}) => {
    setBusy("load");
    setError(null);

    if (!quiet) {
      setNotice(null);
    }

    try {
      const next = await api<EmptyFolderPreview>("/library/empty-folders");
      applyPreview(next);

      if (!quiet) {
        setNotice(`${next.total} empty ${pluralize("folder", next.total)} found.`);
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load({ quiet: true });
  }, []);

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds({});
      return;
    }

    setSelectedIds(Object.fromEntries(folders.map((folder) => [folder.id, true])));
  };

  const toggleFolder = (folder: EmptyFolderItem) => {
    setSelectedIds((current) => ({
      ...current,
      [folder.id]: !current[folder.id]
    }));
  };

  const deleteSelected = async () => {
    if (selectedFolders.length === 0) {
      return;
    }

    if (!window.confirm(`Move ${selectedFolders.length} empty ${pluralize("folder", selectedFolders.length)} to Trash?`)) {
      return;
    }

    setBusy("delete");
    setNotice(null);
    setError(null);

    try {
      const result = await api<EmptyFolderDeleteResult>("/library/empty-folders", {
        method: "DELETE",
        body: JSON.stringify({ ids: selectedFolders.map((folder) => folder.id) })
      });
      applyPreview(result.emptyFolders);
      setErrors(result.errors);
      setNotice(emptyFolderDeleteNotice(result));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const excludeFolder = async (folder: EmptyFolderItem) => {
    setBusy("exclude");
    setNotice(null);
    setError(null);

    try {
      const result = await api<EmptyFolderExcludeResult>("/library/empty-folders/exclusions", {
        method: "POST",
        body: JSON.stringify({ relativePath: folder.relativePath })
      });
      applyPreview(result.emptyFolders);
      setNotice(`${folder.relativePath} excluded from empty folder cleanup.`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel empty-folder-page">
      <div className="toolbar">
        <div className="summary-chips">
          <span>{preview?.total || 0} empty {pluralize("folder", preview?.total || 0)}</span>
          <span>{selectedFolders.length} selected</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={Boolean(busy)}>
            {busy === "load" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{busy === "load" ? "Finding" : "Refresh"}</span>
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={deleteSelected}
            disabled={Boolean(busy) || selectedFolders.length === 0}
          >
            {busy === "delete" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{busy === "delete" ? "Moving" : "Move selected to trash"}</span>
          </button>
        </div>
      </div>
      {busy && (
        <ActionProgress
          label={
            busy === "delete"
              ? "Moving empty folders to trash"
              : busy === "exclude"
                ? "Excluding empty folder"
                : "Finding empty folders"
          }
        />
      )}
      {notice && <div className="notice-bar">{notice}</div>}
      {error && <p className="form-error">{error}</p>}
      {errors.length > 0 && (
        <div className="error-list">
          {errors.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {errors.length > 8 && <span>{errors.length - 8} more errors</span>}
        </div>
      )}
      {preview ? (
        <EmptyFoldersPanel
          allSelected={allSelected}
          preview={preview}
          selectedCount={selectedFolders.length}
          selectedIds={selectedIds}
          disabled={Boolean(busy)}
          onExclude={excludeFolder}
          onToggle={toggleFolder}
          onToggleAll={toggleAll}
        />
      ) : (
        !busy && <EmptyState icon={FolderX} title="No empty folders" />
      )}
    </section>
  );
}

function EmptyFoldersPanel({
  allSelected,
  preview,
  selectedCount,
  selectedIds,
  disabled = false,
  onExclude,
  onToggle,
  onToggleAll
}: {
  allSelected: boolean;
  preview: EmptyFolderPreview;
  selectedCount: number;
  selectedIds: Record<string, boolean>;
  disabled?: boolean;
  onExclude?: (folder: EmptyFolderItem) => void;
  onToggle: (folder: EmptyFolderItem) => void;
  onToggleAll: () => void;
}) {
  return (
    <div className="empty-folder-panel">
      <div className="toolbar compact-toolbar">
        <div className="summary-chips">
          <span>Current pass</span>
          <span>{preview.total} empty {pluralize("folder", preview.total)}</span>
          <span>{selectedCount} selected</span>
        </div>
        <span className="muted">{preview.libraryPath}</span>
      </div>
      {preview.folders.length === 0 ? (
        <EmptyState icon={FolderInput} title="No empty folders" />
      ) : (
        <div className="table-wrap">
          <table className="empty-folder-table">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allSelected} onChange={onToggleAll} aria-label="Select all empty folders" />
                </th>
                <th>Folder</th>
                <th>Parent</th>
                <th>Depth</th>
                {onExclude && <th>Exclude</th>}
              </tr>
            </thead>
            <tbody>
              {preview.folders.map((folder) => (
                <tr key={folder.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedIds[folder.id])}
                      onChange={() => onToggle(folder)}
                      aria-label={`Select ${folder.relativePath}`}
                    />
                  </td>
                  <td>
                    <strong>{folder.name}</strong>
                    <span className="path-diff">{folder.relativePath}</span>
                  </td>
                  <td>{folder.parentRelativePath || "Library root"}</td>
                  <td>{folder.depth}</td>
                  {onExclude && (
                    <td>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => onExclude(folder)}
                        disabled={disabled}
                        title={`Exclude ${folder.relativePath}`}
                        aria-label={`Exclude ${folder.relativePath}`}
                      >
                        <FolderX size={17} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UnindexedPage({
  lastScanFinishedAt,
  onChanged
}: {
  lastScanFinishedAt: string | null;
  onChanged: () => Promise<void>;
}) {
  const [view, setView] = useState<UnindexedFilesView | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<UnindexedFilter>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [busy, setBusy] = useState<"load" | "trash" | null>(null);
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);
  const [matchResults, setMatchResults] = useState<Record<string, UnindexedNavidromeLookupResult>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const lastScanFinishedAtRef = useRef<string | null | undefined>(undefined);
  const tracks = view?.tracks || [];
  const filterCounts = useMemo(() => countUnindexedFilters(tracks), [tracks]);
  const filteredTracks = useMemo(
    () => tracks.filter((track) => unindexedTrackMatchesFilter(track, filter, search)),
    [tracks, filter, search]
  );
  const selectedTracks = tracks.filter((track) => selectedIds[track.id]);
  const pageCount = Math.max(1, Math.ceil(filteredTracks.length / unindexedPageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageStart = currentPage * unindexedPageSize;
  const pageTracks = filteredTracks.slice(pageStart, pageStart + unindexedPageSize);
  const allPageSelected = pageTracks.length > 0 && pageTracks.every((track) => selectedIds[track.id]);
  const firstVisibleItem = filteredTracks.length === 0 ? 0 : pageStart + 1;
  const lastVisibleItem = Math.min(filteredTracks.length, pageStart + pageTracks.length);
  const pageRangeLabel =
    filteredTracks.length === 0
      ? "0 of 0"
      : `${firstVisibleItem.toLocaleString()}-${lastVisibleItem.toLocaleString()} of ${filteredTracks.length.toLocaleString()}`;

  const applyView = (next: UnindexedFilesView) => {
    setView(next);
    setSelectedIds((current) => {
      const validIds = new Set(next.tracks.map((track) => track.id));
      return Object.fromEntries(Object.entries(current).filter(([id, selected]) => selected && validIds.has(id)));
    });
    setMatchResults((current) => {
      const validIds = new Set(next.tracks.map((track) => track.id));
      return Object.fromEntries(Object.entries(current).filter(([id]) => validIds.has(id)));
    });
    setPageIndex(0);
  };

  const load = async ({ quiet = false }: { quiet?: boolean } = {}) => {
    setBusy("load");
    setError(null);

    if (!quiet) {
      setNotice(null);
      setErrors([]);
    }

    try {
      const next = await api<UnindexedFilesView>("/library/unindexed");
      applyView(next);

      if (!quiet) {
        setNotice(`${next.total.toLocaleString()} unindexed ${pluralize("file", next.total)} in the latest scan.`);
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void load({ quiet: true });
  }, []);

  useEffect(() => {
    const previousScanFinishedAt = lastScanFinishedAtRef.current;
    lastScanFinishedAtRef.current = lastScanFinishedAt;

    if (previousScanFinishedAt === undefined || previousScanFinishedAt === lastScanFinishedAt || !lastScanFinishedAt) {
      return;
    }

    void load({ quiet: true });
  }, [lastScanFinishedAt]);

  const updateSearch = (value: string) => {
    setSearch(value);
    setPageIndex(0);
  };

  const selectFilter = (nextFilter: UnindexedFilter) => {
    setFilter(nextFilter);
    setPageIndex(0);
  };

  const toggleTrack = (track: TrackFile) => {
    setSelectedIds((current) => ({
      ...current,
      [track.id]: !current[track.id]
    }));
  };

  const togglePage = () => {
    if (allPageSelected) {
      setSelectedIds((current) => {
        const next = { ...current };
        pageTracks.forEach((track) => {
          delete next[track.id];
        });
        return next;
      });
      return;
    }

    setSelectedIds((current) => ({
      ...current,
      ...Object.fromEntries(pageTracks.map((track) => [track.id, true]))
    }));
  };

  const trashSelected = async () => {
    if (selectedTracks.length === 0) {
      return;
    }

    if (!window.confirm(`Move ${selectedTracks.length} selected unindexed ${pluralize("file", selectedTracks.length)} to the recycle bin?`)) {
      return;
    }

    setBusy("trash");
    setNotice(null);
    setError(null);
    setErrors([]);

    try {
      const result = await api<UnindexedTrashResult>("/library/unindexed/trash", {
        method: "POST",
        body: JSON.stringify({ trackIds: selectedTracks.map((track) => track.id) })
      });

      applyView(result.unindexed);
      setErrors(result.errors);
      setNotice(libraryTrashNotice(result));

      if (result.trashed > 0) {
        await onChanged();
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const checkNavidrome = async (track: TrackFile) => {
    setMatchBusyId(track.id);
    setError(null);

    try {
      const result = await api<UnindexedNavidromeLookupResult>(
        `/library/unindexed/${encodeURIComponent(track.id)}/navidrome-matches`
      );
      setMatchResults((current) => ({
        ...current,
        [track.id]: result
      }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setMatchBusyId(null);
    }
  };

  return (
    <section className="panel unindexed-page">
      <div className="toolbar">
        <div className="summary-chips">
          <span>{view?.total.toLocaleString() || 0} unindexed</span>
          <span>{(view?.counts.possibleStaleScan || 0).toLocaleString()} organized local</span>
          <span>{(view?.counts.noApiMatch || 0).toLocaleString()} no API match</span>
          <span>{formatBytes(view?.totalSize || 0)}</span>
          <span>{selectedTracks.length.toLocaleString()} selected</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={Boolean(busy)}>
            {busy === "load" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{busy === "load" ? "Refreshing" : "Refresh"}</span>
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={trashSelected}
            disabled={Boolean(busy) || selectedTracks.length === 0}
          >
            {busy === "trash" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{busy === "trash" ? "Moving" : "Move selected to trash"}</span>
          </button>
        </div>
      </div>
      <div className="notice-bar diagnostics-feedback" role="note">
        <CircleAlert size={18} aria-hidden="true" />
        <span>
          Match issue? Please report it on GitHub with the file path, reason, and Navidrome search details so NaviClean can fix the matcher.
        </span>
        <a href={navicleanIssuesUrl} target="_blank" rel="noreferrer">
          <span>Open issue</span>
          <ExternalLink size={15} aria-hidden="true" />
        </a>
      </div>
      <div className="organize-preview-tools">
        <div className="segmented-control organize-filter" role="radiogroup" aria-label="Unindexed reason">
          {unindexedFilters.map((candidate) => (
            <button
              key={candidate.id}
              className={filter === candidate.id ? "active" : ""}
              type="button"
              role="radio"
              aria-checked={filter === candidate.id}
              onClick={() => selectFilter(candidate.id)}
            >
              <span>{candidate.label}</span>
              <strong>{filterCounts[candidate.id].toLocaleString()}</strong>
            </button>
          ))}
        </div>
        <div className="toolbar compact-toolbar">
          <label className="search-box">
            <Search size={17} />
            <input value={search} onChange={(event) => updateSearch(event.target.value)} placeholder="Search unindexed files" />
          </label>
          <div className="pagination-controls" aria-label="Unindexed pages">
            <button
              className="icon-button"
              type="button"
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              disabled={currentPage === 0}
              title="Previous page"
            >
              <ChevronLeft size={18} />
            </button>
            <span>{pageRangeLabel}</span>
            <button
              className="icon-button"
              type="button"
              onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
              disabled={currentPage >= pageCount - 1}
              title="Next page"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>
      {busy && <ActionProgress label={busy === "trash" ? "Moving unindexed files to trash" : "Loading unindexed files"} />}
      {notice && <div className="notice-bar">{notice}</div>}
      {error && <p className="form-error">{error}</p>}
      {errors.length > 0 && (
        <div className="error-list">
          {errors.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {errors.length > 8 && <span>{errors.length - 8} more errors</span>}
        </div>
      )}
      {view && pageTracks.length === 0 && !busy ? (
        <EmptyState
          icon={Check}
          title={view.total === 0 ? "No unindexed files" : "No files in this filter"}
          description={view.total === 0 ? "Matched files fall off this page automatically after a successful scan." : "Try a different reason filter or search term."}
        />
      ) : null}
      {pageTracks.length > 0 && (
        <UnindexedTable
          allSelected={allPageSelected}
          disabled={Boolean(busy)}
          tracks={pageTracks}
          selectedIds={selectedIds}
          onToggle={toggleTrack}
          onToggleAll={togglePage}
          matchBusyId={matchBusyId}
          matchResults={matchResults}
          onCheckNavidrome={checkNavidrome}
        />
      )}
    </section>
  );
}

function UnindexedTable({
  allSelected,
  disabled,
  tracks,
  selectedIds,
  onToggle,
  onToggleAll,
  matchBusyId,
  matchResults,
  onCheckNavidrome
}: {
  allSelected: boolean;
  disabled: boolean;
  tracks: TrackFile[];
  selectedIds: Record<string, boolean>;
  onToggle: (track: TrackFile) => void;
  onToggleAll: () => void;
  matchBusyId: string | null;
  matchResults: Record<string, UnindexedNavidromeLookupResult>;
  onCheckNavidrome: (track: TrackFile) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="unindexed-table">
        <thead>
          <tr>
            <th>
              <input type="checkbox" checked={allSelected} onChange={onToggleAll} disabled={disabled} aria-label="Select visible unindexed files" />
            </th>
            <th>Reason</th>
            <th>Track</th>
            <th>Current path</th>
            <th>Quality</th>
            <th>Navidrome</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => {
            const matchResult = matchResults[track.id];

            return (
              <Fragment key={track.id}>
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedIds[track.id])}
                      onChange={() => onToggle(track)}
                      disabled={disabled}
                      aria-label={`Select ${track.relativePath}`}
                    />
                  </td>
                  <td>
                    <StatusPill active={track.navidromeEnrichment?.code === "no-api-match"} label={unindexedReasonShortLabel(track)} />
                    <span className="status-detail navidrome-diagnostic">{track.navidromeEnrichment?.message}</span>
                  </td>
                  <td>
                    <strong>{track.title}</strong>
                    <span>{libraryMeta([track.artist, track.album, albumReleaseLabel(track), trackNumberLabel(track)])}</span>
                    <span>{libraryMeta([track.isrc ? `ISRC ${track.isrc}` : "", track.managedBy === "spotifybu" ? "SpotifyBU" : ""])}</span>
                  </td>
                  <td>
                    <span className="path-diff">{track.relativePath}</span>
                  </td>
                  <td>
                    <span className="quality-pill">{qualitySummary(track)}</span>
                    <span>{formatBytes(track.size)}</span>
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => onCheckNavidrome(track)}
                      disabled={disabled || matchBusyId === track.id}
                      title={`Find Navidrome matches for ${track.title}`}
                      aria-label={`Find Navidrome matches for ${track.title}`}
                    >
                      {matchBusyId === track.id ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
                    </button>
                  </td>
                </tr>
                {matchResult && (
                  <tr className="unindexed-match-row">
                    <td colSpan={6}>
                      <UnindexedMatchPanel result={matchResult} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function UnindexedMatchPanel({ result }: { result: UnindexedNavidromeLookupResult }) {
  return (
    <div className="unindexed-match-panel">
      <div className="toolbar compact-toolbar">
        <div>
          <strong>Navidrome search</strong>
          <span className="muted">Query: {result.query}</span>
        </div>
        <span className="muted">{result.message}</span>
      </div>
      <div className="unindexed-local-match">
        <strong>Local file</strong>
        <span>{result.track.relativePath}</span>
        <span>{unindexedTrackSummary(result.track)}</span>
      </div>
      {result.candidates.length === 0 ? (
        <span className="muted">No candidates came back from Navidrome search.</span>
      ) : (
        <div className="unindexed-candidate-list">
          {result.candidates.map((candidate) => (
            <UnindexedCandidatePanel candidate={candidate} key={candidate.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function UnindexedCandidatePanel({ candidate }: { candidate: UnindexedNavidromeCandidate }) {
  return (
    <div className="unindexed-candidate">
      <div>
        <strong>{candidate.navidrome.title || "Untitled"}</strong>
        <span>{unindexedCandidateSummary(candidate)}</span>
        <span className="path-diff">{candidate.navidrome.relativePath || candidate.navidrome.path || "No Navidrome path"}</span>
      </div>
      <div className="unindexed-check-grid">
        <span>{unindexedCheckLabel("Abs", candidate.checks.absolutePath)}</span>
        <span>{unindexedCheckLabel("Rel", candidate.checks.relativePath)}</span>
        <span>{unindexedCheckLabel("Name+size", candidate.checks.filenameSize)}</span>
        <span>{unindexedCheckLabel("Metadata", candidate.checks.metadataKey)}</span>
      </div>
      <div className="unindexed-reasons">
        <strong>{candidate.acceptedBy ? `Would match by ${navidromeMatchMethodLabel(candidate.acceptedBy)}` : `Score ${candidate.score}`}</strong>
        {candidate.rejectedReasons.map((reason) => (
          <span key={reason}>{reason}</span>
        ))}
      </div>
    </div>
  );
}

function NonMusicFilesPage() {
  const [view, setView] = useState<NonMusicFilesView | null>(null);
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Record<string, boolean>>({});
  const [expandedGroupKeys, setExpandedGroupKeys] = useState<Record<string, boolean>>({});
  const [groupDetails, setGroupDetails] = useState<Record<string, NonMusicFileGroupDetail>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"trash" | null>(null);
  const [detailLoadingKey, setDetailLoadingKey] = useState<string | null>(null);
  const [fileTrashBusyId, setFileTrashBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const groups = view?.groups || [];
  const selectedGroups = groups.filter((group) => selectedGroupKeys[group.key]);
  const selectedFileCount = selectedGroups.reduce((total, group) => total + group.count, 0);
  const selectedBytes = selectedGroups.reduce((total, group) => total + group.totalSize, 0);
  const allSelected = groups.length > 0 && selectedGroups.length === groups.length;

  const applyView = (next: NonMusicFilesView) => {
    setView(next);
    setErrors(next.errors);
    setSelectedGroupKeys((current) => {
      const validKeys = new Set(next.groups.map((group) => group.key));
      return Object.fromEntries(Object.entries(current).filter(([key, selected]) => selected && validKeys.has(key)));
    });
    setExpandedGroupKeys((current) => {
      const validKeys = new Set(next.groups.map((group) => group.key));
      return Object.fromEntries(Object.entries(current).filter(([key, expanded]) => expanded && validKeys.has(key)));
    });
    setGroupDetails((current) => {
      const validKeys = new Set(next.groups.map((group) => group.key));
      return Object.fromEntries(Object.entries(current).filter(([key]) => validKeys.has(key)));
    });
  };

  const load = async ({ clearNotice = true }: { clearNotice?: boolean } = {}) => {
    setLoading(true);

    if (clearNotice) {
      setNotice(null);
      setErrors([]);
    }

    try {
      applyView(await api<NonMusicFilesView>("/library/non-music-files"));
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load({ clearNotice: false });
  }, []);

  const toggleAll = () => {
    if (allSelected) {
      setSelectedGroupKeys({});
      return;
    }

    setSelectedGroupKeys(Object.fromEntries(groups.map((group) => [group.key, true])));
  };

  const toggleGroup = (groupKey: string) => {
    setSelectedGroupKeys((current) => ({
      ...current,
      [groupKey]: !current[groupKey]
    }));
  };

  const loadGroupDetail = async (groupKey: string) => {
    setDetailLoadingKey(groupKey);
    setErrors([]);

    try {
      const detail = await api<NonMusicFileGroupDetail>(
        `/library/non-music-files/group?key=${encodeURIComponent(groupKey)}`
      );
      setGroupDetails((current) => ({ ...current, [groupKey]: detail }));
      setErrors(detail.errors);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setDetailLoadingKey(null);
    }
  };

  const toggleGroupExpanded = (group: NonMusicFileGroup) => {
    if (expandedGroupKeys[group.key]) {
      setExpandedGroupKeys((current) => ({ ...current, [group.key]: false }));
      return;
    }

    setExpandedGroupKeys((current) => ({ ...current, [group.key]: true }));

    if (!groupDetails[group.key]) {
      void loadGroupDetail(group.key);
    }
  };

  const trashFile = async (group: NonMusicFileGroup, file: NonMusicFileItem) => {
    if (!window.confirm(`Move ${file.relativePath} to Trash?`)) {
      return;
    }

    setFileTrashBusyId(file.id);
    setNotice(null);
    setErrors([]);

    try {
      const result = await api<NonMusicFileTrashResult>("/library/non-music-files/trash-files", {
        method: "POST",
        body: JSON.stringify({ fileIds: [file.id], groupKey: group.key })
      });
      applyView(result.nonMusicFiles);
      setErrors(result.errors);
      setNotice(nonMusicTrashNotice(result));

      const refreshedGroup = result.group;

      if (refreshedGroup) {
        setExpandedGroupKeys((current) => ({ ...current, [group.key]: true }));
        setGroupDetails((current) => ({ ...current, [group.key]: refreshedGroup }));
      } else {
        setExpandedGroupKeys((current) => ({ ...current, [group.key]: false }));
        setGroupDetails((current) => {
          const next = { ...current };
          delete next[group.key];
          return next;
        });
      }
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setFileTrashBusyId(null);
    }
  };

  const trashSelected = async () => {
    if (selectedGroups.length === 0) {
      return;
    }

    if (
      !window.confirm(
        `Move ${selectedFileCount.toLocaleString()} selected non-music ${pluralize("file", selectedFileCount)} to Trash?`
      )
    ) {
      return;
    }

    setBusy("trash");
    setNotice(null);
    setErrors([]);

    try {
      const result = await api<NonMusicTrashResult>("/library/non-music-files/trash", {
        method: "POST",
        body: JSON.stringify({ groupKeys: selectedGroups.map((group) => group.key) })
      });
      applyView(result.nonMusicFiles);
      setSelectedGroupKeys({});
      setErrors(result.errors);
      setNotice(nonMusicTrashNotice(result));
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel non-music-page">
      <div className="toolbar">
        <div className="summary-chips">
          <span>{(view?.nonMusicFiles || 0).toLocaleString()} non-music files</span>
          <span>{(view?.audioFiles || 0).toLocaleString()} audio files</span>
          <span>{formatBytes(view?.totalSize || 0)}</span>
          <span>{selectedGroups.length} selected</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || Boolean(busy)}>
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={trashSelected}
            disabled={loading || Boolean(busy) || selectedGroups.length === 0}
          >
            {busy === "trash" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{busy === "trash" ? "Moving" : "Move selected to trash"}</span>
          </button>
        </div>
      </div>
      {(loading || busy) && <ActionProgress label={busy ? "Moving non-music files to trash" : "Scanning non-music files"} />}
      {notice && <div className="notice-bar">{notice}</div>}
      {errors.length ? (
        <div className="error-list">
          {errors.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {errors.length > 8 && <span>{errors.length - 8} more errors</span>}
        </div>
      ) : null}
      {!loading && groups.length === 0 ? (
        <EmptyState icon={FileQuestion} title="No non-music files" />
      ) : groups.length > 0 ? (
        <div className="table-wrap">
          <table className="non-music-table">
            <thead>
              <tr>
                <th></th>
                <th>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={loading || Boolean(busy)}
                    aria-label="Select all non-music file groups"
                  />
                </th>
                <th>Type</th>
                <th>Classification</th>
                <th>Files</th>
                <th>Size</th>
                <th>Examples</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const expanded = Boolean(expandedGroupKeys[group.key]);
                const detail = groupDetails[group.key];
                const detailLoading = detailLoadingKey === group.key;

                return (
                  <Fragment key={group.key}>
                    <tr className="non-music-group-row">
                      <td>
                        <button
                          className="icon-button"
                          type="button"
                          onClick={() => toggleGroupExpanded(group)}
                          disabled={loading || Boolean(busy)}
                          title={expanded ? `Collapse ${group.label}` : `Expand ${group.label}`}
                          aria-label={expanded ? `Collapse ${group.label}` : `Expand ${group.label}`}
                        >
                          {detailLoading ? (
                            <Loader2 className="spin" size={17} />
                          ) : expanded ? (
                            <ChevronDown size={17} />
                          ) : (
                            <ChevronRight size={17} />
                          )}
                        </button>
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(selectedGroupKeys[group.key])}
                          onChange={() => toggleGroup(group.key)}
                          disabled={loading || Boolean(busy)}
                          aria-label={`Select ${group.label}`}
                        />
                      </td>
                      <td>
                        <button
                          className="group-toggle-button"
                          type="button"
                          onClick={() => toggleGroupExpanded(group)}
                          disabled={loading || Boolean(busy)}
                        >
                          <strong>{group.label}</strong>
                          <span>{group.description}</span>
                        </button>
                      </td>
                      <td>
                        <span className={`classification-pill ${group.classification}`}>
                          {nonMusicClassificationLabel(group.classification)}
                        </span>
                      </td>
                      <td>{group.count.toLocaleString()}</td>
                      <td>{formatBytes(group.totalSize)}</td>
                      <td>
                        <div className="example-list">
                          {group.examples.map((example) => (
                            <span className="path-diff" key={example.relativePath}>
                              {example.relativePath}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="non-music-detail-row">
                        <td colSpan={7}>
                          <NonMusicGroupDetailPanel
                            busyFileId={fileTrashBusyId}
                            detail={detail}
                            loading={detailLoading}
                            onTrashFile={(file) => trashFile(group, file)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {selectedGroups.length > 0 && (
            <p className="notice">
              {selectedFileCount.toLocaleString()} selected {pluralize("file", selectedFileCount)} / {formatBytes(selectedBytes)}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

function NonMusicGroupDetailPanel({
  busyFileId,
  detail,
  loading,
  onTrashFile
}: {
  busyFileId: string | null;
  detail?: NonMusicFileGroupDetail;
  loading: boolean;
  onTrashFile: (file: NonMusicFileItem) => void;
}) {
  if (loading && !detail) {
    return <ActionProgress label="Loading files" />;
  }

  if (!detail) {
    return <EmptyState icon={FileQuestion} title="No files loaded" />;
  }

  if (detail.files.length === 0) {
    return <EmptyState icon={FileQuestion} title="No files left in this group" />;
  }

  return (
    <div className="non-music-file-panel">
      <div className="summary-chips">
        <span>{detail.files.length.toLocaleString()} files</span>
        <span>{formatBytes(detail.group.totalSize)}</span>
      </div>
      <div className="non-music-file-list">
        {detail.files.map((file) => (
          <div className="non-music-file-row" key={file.id}>
            <div>
              <strong>{file.filename}</strong>
              <span className="path-diff">{file.relativePath}</span>
            </div>
            <span>{formatBytes(file.size)}</span>
            <button
              className="icon-button danger-icon"
              type="button"
              onClick={() => onTrashFile(file)}
              disabled={Boolean(busyFileId)}
              title={`Move ${file.relativePath} to Trash`}
              aria-label={`Move ${file.relativePath} to Trash`}
            >
              {busyFileId === file.id ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

async function loadLibraryView(
  view: "artists" | "albums" | "tracks",
  search: string,
  selectedArtist: LibraryArtistSummary | null,
  selectedAlbum: LibraryAlbumSummary | null,
  artistPage: number
) {
  if (view === "artists") {
    const body = await api<{
      artists: LibraryArtistSummary[];
      artistTotal: number;
      page: number;
      pageSize: number;
      total: number;
    }>(
      `/library/artists?search=${encodeURIComponent(search)}&page=${artistPage}&pageSize=${libraryArtistPageSize}`
    );
    return {
      view,
      artists: body.artists,
      artistTotal: body.artistTotal,
      page: body.page,
      pageSize: body.pageSize,
      total: body.total
    };
  }

  if (view === "albums") {
    if (!selectedArtist) {
      return { view, albums: [] };
    }

    const body = await api<{ albums: LibraryAlbumSummary[] }>(
      `/library/artists/${selectedArtist.id}/albums?search=${encodeURIComponent(search)}`
    );
    return { view, albums: body.albums };
  }

  if (!selectedArtist || !selectedAlbum) {
    return { view, tracks: [] };
  }

  const body = await api<{ tracks: TrackFile[] }>(
    `/library/artists/${selectedArtist.id}/albums/${selectedAlbum.id}/tracks`
  );
  return { view, tracks: filterLibraryTracks(body.tracks, search) };
}

function LibraryArtistGrid({
  artists,
  busyKey,
  onOpen,
  onTrash
}: {
  artists: LibraryArtistSummary[];
  busyKey: string | null;
  onOpen: (artist: LibraryArtistSummary) => void;
  onTrash: (artist: LibraryArtistSummary) => void;
}) {
  if (artists.length === 0) {
    return <EmptyState icon={UserRound} title="No artists" />;
  }

  return (
    <div className="library-card-grid">
      {artists.map((artist) => (
        <article className="library-card" key={artist.id}>
          <button className="library-card-main" type="button" onClick={() => onOpen(artist)}>
            <LibraryArtwork
              className="artist-thumb"
              icon={UserRound}
              label={artist.thumbnailLabel}
              src={artist.artworkUrl}
            />
            <span className="library-card-copy">
              <strong>{artist.name}</strong>
              <span>{artist.albumCount} {pluralize("album", artist.albumCount)} / {artist.trackCount} {pluralize("track", artist.trackCount)}</span>
              <span>{libraryMeta([formatBytes(artist.totalSize), artist.formats.join(" / "), issueLabel(artist.issueCount)])}</span>
            </span>
            <ChevronRight size={18} />
          </button>
          <button
            className="icon-button danger-icon"
            type="button"
            onClick={() => onTrash(artist)}
            disabled={Boolean(busyKey)}
            title={`Trash ${artist.name}`}
            aria-label={`Trash ${artist.name}`}
          >
            {busyKey === `artist:${artist.id}` ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
          </button>
        </article>
      ))}
    </div>
  );
}

function LibraryAlbumGrid({
  albums,
  busyKey,
  onOpen,
  onTrash
}: {
  albums: LibraryAlbumSummary[];
  busyKey: string | null;
  onOpen: (album: LibraryAlbumSummary) => void;
  onTrash: (album: LibraryAlbumSummary) => void;
}) {
  if (albums.length === 0) {
    return <EmptyState icon={AlbumIcon} title="No albums" />;
  }

  return (
    <div className="library-card-grid album-grid">
      {albums.map((album) => (
        <article className="library-card album-card" key={album.id}>
          <button className="library-card-main" type="button" onClick={() => onOpen(album)}>
            <LibraryArtwork
              className="album-thumb"
              icon={AlbumIcon}
              label={album.thumbnailLabel}
              src={album.artworkUrl}
            />
            <span className="library-card-copy">
              <strong>{album.title}</strong>
              <span>{libraryMeta([album.albumType, album.yearLabel, `${album.trackCount} ${pluralize("track", album.trackCount)}`])}</span>
              <span>{libraryMeta([formatBytes(album.totalSize), album.duration ? formatDuration(album.duration) : "", album.formats.join(" / "), issueLabel(album.issueCount)])}</span>
            </span>
            <ChevronRight size={18} />
          </button>
          <button
            className="icon-button danger-icon"
            type="button"
            onClick={() => onTrash(album)}
            disabled={Boolean(busyKey)}
            title={`Trash ${album.title}`}
            aria-label={`Trash ${album.title}`}
          >
            {busyKey === `album:${album.id}` ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
          </button>
        </article>
      ))}
    </div>
  );
}

function LibraryArtwork({
  className,
  icon: Icon,
  label,
  src
}: {
  className: string;
  icon: typeof Database;
  label: string;
  src: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span className={`library-thumb ${className}${showImage ? " has-art" : ""}`} aria-hidden="true">
      {showImage ? (
        <img src={src || ""} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <>
          <Icon size={22} />
          <strong>{label}</strong>
        </>
      )}
    </span>
  );
}

function LibraryTrackTable({
  tracks,
  busyKey,
  onTrash
}: {
  tracks: TrackFile[];
  busyKey: string | null;
  onTrash: (track: TrackFile) => void;
}) {
  if (tracks.length === 0) {
    return <EmptyState icon={Music2} title="No tracks" />;
  }

  return (
    <div className="table-wrap">
      <table className="library-track-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Track</th>
            <th>Current path</th>
            <th>Quality</th>
            <th>Trash</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => (
            <tr key={track.id}>
              <td>{trackNumberLabel(track)}</td>
              <td>
                <strong>{track.title}</strong>
                <span>{albumReleaseLabel(track)}</span>
              </td>
              <td>{track.relativePath}</td>
              <td>
                <span className="quality-pill">{qualitySummary(track)}</span>
              </td>
              <td>
                <button
                  className="icon-button danger-icon"
                  type="button"
                  onClick={() => onTrash(track)}
                  disabled={Boolean(busyKey)}
                  title={`Trash ${track.title}`}
                  aria-label={`Trash ${track.title}`}
                >
                  {busyKey === `track:${track.id}` ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConvertPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const [view, setView] = useState<AudioConvertView | null>(null);
  const [sourceExtension, setSourceExtension] = useState("");
  const [targetFormat, setTargetFormat] = useState<AudioConvertTargetFormat>("mp3");
  const [quality, setQuality] = useState<AudioConvertQuality>("320k");
  const [job, setJob] = useState<AudioConvertJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [convertSearch, setConvertSearch] = useState("");
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const refreshedJobIds = useRef<Set<string>>(new Set());

  const groups = view?.groups || [];
  const selectedGroup = groups.find((group) => group.extension === sourceExtension) || groups[0] || null;
  const targetOptions = audioConvertTargetOptions.filter((option) => option.extension !== selectedGroup?.extension);
  const selectedTargetOption = audioConvertTargetOption(targetFormat) || targetOptions[0];
  const qualityOptions = audioConvertQualityOptionsForTarget(selectedTargetOption?.id || targetFormat);
  const activeJob = isAudioConvertJobActive(job);
  const targetQuality = selectedTargetOption?.lossless ? "lossless" : quality;
  const selectedGroupFiles = selectedGroup?.files || [];
  const filteredConvertFiles = useMemo(
    () => filterAudioConvertFiles(selectedGroupFiles, convertSearch),
    [selectedGroupFiles, convertSearch]
  );
  const selectedConvertFiles = selectedGroupFiles.filter((file) => selectedTrackIds.has(file.id));
  const selectedConvertFileIds = selectedConvertFiles.map((file) => file.id);
  const selectedConvertSize = selectedConvertFiles.reduce((total, file) => total + file.size, 0);
  const filteredSelectedCount = filteredConvertFiles.filter((file) => selectedTrackIds.has(file.id)).length;
  const allFilteredSelected = filteredConvertFiles.length > 0 && filteredSelectedCount === filteredConvertFiles.length;

  const load = async ({ clearNotice = true }: { clearNotice?: boolean } = {}) => {
    setLoading(true);

    if (clearNotice) {
      setNotice(null);
      setError(null);
    }

    try {
      const next = await api<AudioConvertView>("/convert");
      setView(next);

      if (next.groups.length > 0 && !next.groups.some((group) => group.extension === sourceExtension)) {
        setSourceExtension(next.groups[0].extension);
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load({ clearNotice: false });
    api<{ job: AudioConvertJob | null }>("/convert/jobs/active")
      .then((body) => {
        if (body.job) {
          setJob(body.job);
        }
      })
      .catch((caught) => setError((caught as Error).message));
  }, []);

  useEffect(() => {
    if (!selectedGroup) {
      setConvertSearch("");
      setSelectedTrackIds(new Set());
      return;
    }

    setConvertSearch("");
    setSelectedTrackIds(new Set(selectedGroup.files.map((file) => file.id)));
  }, [selectedGroup?.extension, selectedGroup?.count]);

  useEffect(() => {
    if (!selectedGroup) {
      return;
    }

    const nextTarget = defaultAudioConvertTarget(selectedGroup.extension);

    if (audioConvertTargetOption(targetFormat)?.extension === selectedGroup.extension) {
      setTargetFormat(nextTarget);
    }
  }, [selectedGroup?.extension, targetFormat]);

  useEffect(() => {
    const target = audioConvertTargetOption(targetFormat);

    if (target?.lossless && quality !== "lossless") {
      setQuality("lossless");
    }

    if (target && !target.lossless && quality === "lossless") {
      setQuality("320k");
    }
  }, [targetFormat, quality]);

  useEffect(() => {
    if (!job || !isAudioConvertJobActive(job)) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      api<{ job: AudioConvertJob }>(`/convert/jobs/${encodeURIComponent(job.id)}`)
        .then((body) => setJob(body.job))
        .catch((caught) => setError((caught as Error).message));
    }, 1200);

    return () => window.clearInterval(interval);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!job || isAudioConvertJobActive(job) || refreshedJobIds.current.has(job.id)) {
      return;
    }

    refreshedJobIds.current.add(job.id);
    setNotice(audioConvertJobNotice(job));
    void load({ clearNotice: false });
    void onChanged().catch((caught) => setError((caught as Error).message));
  }, [job?.id, job?.status]);

  const startConversion = async () => {
    if (!selectedGroup || !selectedTargetOption) {
      return;
    }

    if (selectedConvertFileIds.length === 0) {
      setError("Choose at least one file to convert.");
      return;
    }

    const confirmed = window.confirm(
      `Convert ${selectedConvertFileIds.length.toLocaleString()} selected ${selectedGroup.extension.toUpperCase()} ${pluralize("file", selectedConvertFileIds.length)} to ${selectedTargetOption.extension.toUpperCase()}? Originals are deleted after each successful conversion.`
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);
    setNotice(null);
    setError(null);

    try {
      const body = await api<{ job: AudioConvertJob }>("/convert/jobs", {
        method: "POST",
        body: JSON.stringify({
          quality: targetQuality,
          sourceExtension: selectedGroup.extension,
          targetFormat: selectedTargetOption.id,
          trackIds: selectedConvertFileIds
        })
      });
      setJob(body.job);
      setNotice(`Conversion started for ${selectedConvertFileIds.length.toLocaleString()} ${pluralize("file", selectedConvertFileIds.length)}.`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleConvertFile = (fileId: string, checked: boolean) => {
    setSelectedTrackIds((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(fileId);
      } else {
        next.delete(fileId);
      }

      return next;
    });
  };

  const toggleFilteredConvertFiles = (checked: boolean) => {
    setSelectedTrackIds((current) => {
      const next = new Set(current);

      for (const file of filteredConvertFiles) {
        if (checked) {
          next.add(file.id);
        } else {
          next.delete(file.id);
        }
      }

      return next;
    });
  };

  return (
    <section className="stack convert-page">
      <div className="notice-bar safety app-risk-banner" role="note">
        <CircleAlert size={18} aria-hidden="true" />
        <div>
          <strong>Conversion replaces originals</strong>
          <span>
            NaviClean writes each converted file beside the original, then deletes the original only after that item succeeds.
            Back up the library first if you want to keep source files.
          </span>
          <span>Converting lossy files to FLAC or WAV will not restore quality that is already gone.</span>
        </div>
      </div>

      <section className="panel">
        <div className="toolbar">
          <div className="summary-chips">
            <span>{(view?.totalFiles || 0).toLocaleString()} audio files</span>
            <span>{groups.length.toLocaleString()} formats</span>
            <span>{formatBytes(view?.totalSize || 0)}</span>
          </div>
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || busy || activeJob}>
              {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              <span>{loading ? "Loading" : "Refresh"}</span>
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={startConversion}
              disabled={loading || busy || activeJob || !selectedGroup || !selectedTargetOption || selectedConvertFileIds.length === 0}
            >
              {busy || activeJob ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              <span>{activeJob ? "Converting" : "Convert"}</span>
            </button>
          </div>
        </div>

        {loading && <ActionProgress label="Loading convertible audio files" />}
        {notice && <div className="notice-bar">{notice}</div>}
        {error && <p className="form-error">{error}</p>}

        {!loading && groups.length === 0 ? (
          <EmptyState
            icon={Music2}
            title="No audio formats found"
            description="Run a NaviClean scan so the converter can read the current catalog."
          />
        ) : (
          <div className="convert-layout">
            <div className="convert-controls">
              <label>
                Source format
                <div className="filter-select">
                  <select
                    value={selectedGroup?.extension || ""}
                    onChange={(event) => setSourceExtension(event.target.value)}
                    disabled={activeJob}
                  >
                    {groups.map((group) => (
                      <option key={group.extension} value={group.extension}>
                        {group.extension.toUpperCase()} - {group.count.toLocaleString()} {pluralize("file", group.count)}
                      </option>
                    ))}
                  </select>
                </div>
              </label>

              <label>
                Convert to
                <div className="filter-select">
                  <select
                    value={selectedTargetOption?.id || targetFormat}
                    onChange={(event) => setTargetFormat(event.target.value as AudioConvertTargetFormat)}
                    disabled={activeJob}
                  >
                    {targetOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </label>

              <label>
                Quality
                <div className="filter-select">
                  <select
                    value={targetQuality}
                    onChange={(event) => setQuality(event.target.value as AudioConvertQuality)}
                    disabled={activeJob || selectedTargetOption?.lossless}
                  >
                    {qualityOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            </div>

            {selectedGroup && selectedTargetOption && (
              <div className="convert-summary">
                <strong>
                  {selectedGroup.extension.toUpperCase()} to {selectedTargetOption.extension.toUpperCase()}
                </strong>
                <span>
                  {selectedConvertFileIds.length.toLocaleString()} selected / {selectedGroup.count.toLocaleString()} total / {formatBytes(selectedConvertSize)} / {audioConvertQualityLabel(targetQuality)}
                </span>
                <span>{selectedTargetOption.description}</span>
              </div>
            )}

            {selectedGroup && (
              <ConvertFileTable
                activeJob={activeJob}
                allFilteredSelected={allFilteredSelected}
                files={filteredConvertFiles}
                filteredSelectedCount={filteredSelectedCount}
                group={selectedGroup}
                onSearchChange={setConvertSearch}
                onToggleFile={toggleConvertFile}
                onToggleFiltered={toggleFilteredConvertFiles}
                search={convertSearch}
                selectedCount={selectedConvertFileIds.length}
                selectedTrackIds={selectedTrackIds}
              />
            )}
          </div>
        )}
      </section>

      {job && (
        <section className="panel convert-job-panel">
          <div className="panel-title split">
            <div>
              <h2>Conversion Job</h2>
              <span>{audioConvertJobStatusLabel(job)}</span>
            </div>
            <StatusPill active={isAudioConvertJobActive(job)} label={job.status} />
          </div>
          <DeterminateProgress label={audioConvertJobProgressLabel(job)} value={audioConvertJobProgress(job)} />
          <div className="summary-chips">
            <span>{job.completedCount.toLocaleString()} completed</span>
            <span>{job.failedCount.toLocaleString()} failed</span>
            <span>{job.pendingCount.toLocaleString()} remaining</span>
            <span>{job.sourceExtension.toUpperCase()} to {audioConvertTargetOption(job.targetFormat)?.extension.toUpperCase()}</span>
            <span>{audioConvertQualityLabel(job.quality)}</span>
          </div>
          {job.errors.length > 0 && (
            <div className="error-list">
              {job.errors.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
          <div className="table-wrap">
            <table className="convert-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {job.items.map((item) => (
                  <tr key={item.trackId}>
                    <td>
                      <strong>{pathFilename(item.sourceRelativePath)}</strong>
                      <span>{item.sourceRelativePath}</span>
                      {item.error && <span className="status-detail">{item.error}</span>}
                    </td>
                    <td>
                      <span>{item.targetRelativePath}</span>
                    </td>
                    <td>{audioConvertItemStatusLabel(item.status)}</td>
                    <td>{item.status === "converting" ? `${item.progress}%` : item.status === "completed" ? "100%" : ""}</td>
                    <td>
                      <span>{formatBytes(item.sourceSize)}</span>
                      {item.outputSize ? <span>{formatBytes(item.outputSize)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}

function ConvertFileTable({
  activeJob,
  allFilteredSelected,
  files,
  filteredSelectedCount,
  group,
  onSearchChange,
  onToggleFile,
  onToggleFiltered,
  search,
  selectedCount,
  selectedTrackIds
}: {
  activeJob: boolean;
  allFilteredSelected: boolean;
  files: AudioConvertFile[];
  filteredSelectedCount: number;
  group: AudioConvertExtensionGroup;
  onSearchChange: (value: string) => void;
  onToggleFile: (fileId: string, checked: boolean) => void;
  onToggleFiltered: (checked: boolean) => void;
  search: string;
  selectedCount: number;
  selectedTrackIds: Set<string>;
}) {
  return (
    <div className="convert-file-panel">
      <div className="convert-file-toolbar">
        <div className="search-box convert-search">
          <Search size={17} />
          <input
            disabled={activeJob}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search files"
            value={search}
          />
        </div>
        <div className="summary-chips">
          <span>{selectedCount.toLocaleString()} selected</span>
          <span>{files.length.toLocaleString()} shown</span>
          <span>{filteredSelectedCount.toLocaleString()} shown selected</span>
        </div>
        <div className="button-row">
          <button
            className="secondary-button"
            disabled={activeJob || files.length === 0}
            onClick={() => onToggleFiltered(true)}
            type="button"
          >
            <Check size={17} />
            <span>Select matching</span>
          </button>
          <button
            className="secondary-button"
            disabled={activeJob || files.length === 0}
            onClick={() => onToggleFiltered(false)}
            type="button"
          >
            <CopyX size={17} />
            <span>Clear matching</span>
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="convert-table">
          <thead>
            <tr>
              <th className="convert-select-cell">
                <input
                  aria-label="Toggle matching files"
                  checked={allFilteredSelected}
                  className="convert-file-checkbox"
                  disabled={activeJob || files.length === 0}
                  onChange={(event) => onToggleFiltered(event.target.checked)}
                  type="checkbox"
                />
              </th>
              <th>File</th>
              <th>Track</th>
              <th>Quality</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {files.length === 0 ? (
              <tr>
                <td colSpan={5}>No matching {group.extension.toUpperCase()} files</td>
              </tr>
            ) : (
              files.map((file) => (
                <tr key={file.id}>
                  <td className="convert-select-cell">
                    <input
                      aria-label={`Select ${pathFilename(file.relativePath)}`}
                      checked={selectedTrackIds.has(file.id)}
                      className="convert-file-checkbox"
                      disabled={activeJob}
                      onChange={(event) => onToggleFile(file.id, event.target.checked)}
                      type="checkbox"
                    />
                  </td>
                  <td>
                    <strong>{pathFilename(file.relativePath)}</strong>
                    <span>{file.relativePath}</span>
                  </td>
                  <td>
                    <strong>{file.title}</strong>
                    <span>{libraryMeta([file.artist, file.album, file.duration ? formatDuration(file.duration) : ""])}</span>
                  </td>
                  <td>{audioConvertFileSummary(file)}</td>
                  <td>{formatBytes(file.size)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DuplicatesPage({
  stats,
  onChanged,
  onOpenOrganize
}: {
  stats: LibraryStats | null;
  onChanged: () => Promise<void>;
  onOpenOrganize: () => void;
}) {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [selectedTrashIds, setSelectedTrashIds] = useState<Record<string, boolean>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolveErrors, setResolveErrors] = useState<string[]>([]);
  const [workflowRefreshing, setWorkflowRefreshing] = useState(true);
  const selectedRemoveIds = useMemo(
    () => Object.entries(selectedTrashIds).filter(([, selected]) => selected).map(([id]) => id),
    [selectedTrashIds]
  );
  const workflow = stats?.workflow;
  const duplicateGateIcon = workflow?.stage === "scan" ? Database : LockKeyhole;
  const blockerSummary = workflowBlockerSummary(workflow);

  const load = async () => {
    setLoading(true);

    try {
      const body = await api<{ groups: DuplicateGroup[] }>("/duplicates");
      setGroups(body.groups);
      setSelectedTrashIds((current) => pruneSelectedDuplicateTrashIds(body.groups, current));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    setWorkflowRefreshing(true);
    onChanged()
      .catch((caught) => setNotice((caught as Error).message))
      .finally(() => {
        if (mounted) {
          setWorkflowRefreshing(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!stats?.workflow.duplicateScanReady) {
      setGroups([]);
      setSelectedTrashIds({});
      setLoading(false);
      return;
    }

    load().catch((caught) => setNotice((caught as Error).message));
  }, [stats?.workflow.duplicateScanReady]);

  const selectedDuplicateTrashIdsForGroup = (group: DuplicateGroup) =>
    group.tracks.filter((track) => selectedTrashIds[track.id]).map((track) => track.id);

  const trashDuplicateIds = async (removeIds: string[], operationKey: string) => {
    if (removeIds.length === 0) {
      return;
    }

    if (!window.confirm(`Move ${removeIds.length} duplicate file(s) to the recycle bin? Review every path before continuing.`)) {
      return;
    }

    setBusyKey(operationKey);
    setNotice(null);
    setResolveErrors([]);

    try {
      const result = await api<DuplicateBulkResolveResult>("/duplicates/resolve/bulk", {
        method: "POST",
        body: JSON.stringify({ removeIds })
      });
      const errorSuffix = result.errors.length ? `, ${result.errors.length} errors` : "";
      setNotice(`${result.trashed} moved to recycle bin${errorSuffix}`);
      setResolveErrors(result.errors);
      setSelectedTrashIds((current) => {
        const next = { ...current };
        removeIds.forEach((id) => {
          delete next[id];
        });
        return next;
      });
      await load();
      await onChanged();
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  const trashGroupSelected = async (group: DuplicateGroup) => {
    await trashDuplicateIds(selectedDuplicateTrashIdsForGroup(group), group.key);
  };

  const trashSelected = async () => {
    await trashDuplicateIds(selectedRemoveIds, "bulk");
  };

  const toggleTrashSelection = (group: DuplicateGroup, track: TrackFile) => {
    const selected = Boolean(selectedTrashIds[track.id]);

    if (!selected && duplicateTrashSelectionWouldRemoveGroup(group, selectedTrashIds, track.id)) {
      return;
    }

    setSelectedTrashIds((current) => {
      const next = { ...current };

      if (selected) {
        delete next[track.id];
      } else {
        next[track.id] = true;
      }

      return next;
    });
  };

  if (!workflow?.duplicateScanReady && workflowRefreshing) {
    return (
      <section className="stack">
        <ActionProgress label="Checking organization status" />
        <EmptyState
          icon={RefreshCw}
          title="Checking duplicate readiness"
          description="NaviClean is refreshing the organization preview before deciding whether duplicate cleanup is available."
        />
      </section>
    );
  }

  if (!workflow?.duplicateScanReady) {
    return (
      <section className="stack">
        <div className="notice-bar safety">
          <strong>{duplicateGateNoticeTitle(workflow)}</strong>
          <span>{workflow?.message || "Scan and review organization before duplicate cleanup."}</span>
          {blockerSummary && <span>{blockerSummary}</span>}
        </div>
        {workflow?.stage === "organize" && (
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={onOpenOrganize}>
              <FolderInput size={18} />
              <span>Review organization</span>
            </button>
          </div>
        )}
        <EmptyState
          icon={duplicateGateIcon}
          title={duplicateGateEmptyTitle(workflow)}
          description={duplicateGateEmptyDescription(workflow)}
        />
      </section>
    );
  }

  return (
    <section className="stack">
      <div className="notice-bar safety">
        <strong>Review before recycling</strong>
        <span>Only same organized album, disc/track, title/version, and duration matches are shown.</span>
      </div>
      <div className="toolbar">
        <div className="summary-chips">
          <span>{groups.length} groups</span>
          <span>{selectedRemoveIds.length} selected</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={load} disabled={loading || Boolean(busyKey)}>
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={trashSelected}
            disabled={loading || Boolean(busyKey) || selectedRemoveIds.length === 0}
          >
            {busyKey === "bulk" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{busyKey === "bulk" ? "Moving" : "Trash selected"}</span>
          </button>
        </div>
      </div>
      {notice && <div className="notice-bar">{notice}</div>}
      {busyKey && <ActionProgress label="Moving duplicates to recycle bin" />}
      {loading && <ActionProgress label="Loading duplicate groups" />}
      {resolveErrors.length > 0 && (
        <div className="error-list">
          {resolveErrors.slice(0, 8).map((error) => (
            <span key={error}>{error}</span>
          ))}
          {resolveErrors.length > 8 && <span>{resolveErrors.length - 8} more errors</span>}
        </div>
      )}
      {!loading && groups.length === 0 && (
        <EmptyState
          icon={Check}
          title="No duplicate groups found"
          description="Organization is complete; there are no same-release duplicate matches to clean up."
        />
      )}
      {groups.map((group) => {
        const groupSelectedRemoveIds = selectedDuplicateTrashIdsForGroup(group);

        return (
          <article className="panel duplicate-group" key={group.key}>
            <div className="panel-title split">
              <div>
                <h2>{group.tracks[0].title}</h2>
                <span>{group.reason}</span>
              </div>
              <button
                className="danger-button"
                type="button"
                onClick={() => trashGroupSelected(group)}
                disabled={Boolean(busyKey) || groupSelectedRemoveIds.length === 0}
              >
                {busyKey === group.key ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
                <span>Trash selected</span>
              </button>
            </div>
            <div className="duplicate-list">
              {group.tracks.map((track) => {
                const selected = Boolean(selectedTrashIds[track.id]);
                const trashDisabled =
                  Boolean(busyKey) || (!selected && duplicateTrashSelectionWouldRemoveGroup(group, selectedTrashIds, track.id));

                return (
                  <div className="duplicate-option" key={track.id}>
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={trashDisabled}
                      onChange={() => toggleTrashSelection(group, track)}
                      aria-label={`Trash ${track.relativePath}`}
                      title="Trash this file"
                    />
                    <div>
                      <strong>{track.extension.toUpperCase().replace(".", "")} - {track.title}</strong>
                      <span>{albumReleaseLabel(track)}</span>
                      <span>{track.relativePath}</span>
                    </div>
                    <em>{qualitySummary(track)}</em>
                  </div>
                );
              })}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function TrashPage() {
  const [view, setView] = useState<RecycleBinView | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"restore" | "selected" | "empty" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const items = view?.items || [];
  const typeOptions = useMemo(() => buildTrashTypeOptions(items), [items]);
  const filteredItems = useMemo(() => filterTrashItems(items, filter, typeFilter), [filter, items, typeFilter]);
  const selectedItems = filteredItems.filter((item) => selectedIds[item.id]);
  const allSelected = filteredItems.length > 0 && selectedItems.length === filteredItems.length;
  const filtersActive = Boolean(filter.trim()) || typeFilter !== "all";

  const load = async ({ clearNotice = true }: { clearNotice?: boolean } = {}) => {
    setLoading(true);
    if (clearNotice) {
      setNotice(null);
      setErrors([]);
    }

    try {
      const next = await api<RecycleBinView>("/recycle-bin");
      setView(next);
      setSelectedIds((current) => {
        const validIds = new Set(next.items.map((item) => item.id));
        return Object.fromEntries(Object.entries(current).filter(([id, selected]) => selected && validIds.has(id)));
      });
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (typeFilter !== "all" && !typeOptions.some((option) => option.key === typeFilter)) {
      setTypeFilter("all");
    }
  }, [typeFilter, typeOptions]);

  const toggleAll = () => {
    setSelectedIds((current) => {
      if (allSelected) {
        const next = { ...current };
        for (const item of filteredItems) {
          delete next[item.id];
        }
        return next;
      }

      return {
        ...current,
        ...Object.fromEntries(filteredItems.map((item) => [item.id, true]))
      };
    });
  };

  const toggleItem = (item: RecycleBinItem) => {
    setSelectedIds((current) => ({
      ...current,
      [item.id]: !current[item.id]
    }));
  };

  const restoreSelected = async () => {
    if (selectedItems.length === 0) {
      return;
    }

    if (!window.confirm(`Restore ${selectedItems.length} selected item(s) to their original library paths?`)) {
      return;
    }

    setBusy("restore");
    setNotice(null);
    setErrors([]);

    try {
      const result = await api<RecycleBinRestoreResult>("/recycle-bin/restore", {
        method: "POST",
        body: JSON.stringify({ ids: selectedItems.map((item) => item.id) })
      });
      setView(result.recycleBin);
      setSelectedIds({});
      setErrors(result.errors);
      setNotice(`${result.restoredFiles} restored (${formatBytes(result.restoredBytes)}).`);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteSelected = async () => {
    if (selectedItems.length === 0) {
      return;
    }

    if (!window.confirm(`Permanently delete ${selectedItems.length} selected item(s) from Trash?`)) {
      return;
    }

    setBusy("selected");
    setNotice(null);
    setErrors([]);

    try {
      const result = await api<RecycleBinDeleteResult>("/recycle-bin/items", {
        method: "DELETE",
        body: JSON.stringify({ ids: selectedItems.map((item) => item.id) })
      });
      setView(result.recycleBin);
      setSelectedIds({});
      setErrors(result.errors);
      setNotice(`${result.deletedFiles} permanently deleted (${formatBytes(result.deletedBytes)}).`);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const emptyTrash = async () => {
    if (!view?.totalFiles) {
      return;
    }

    if (!window.confirm(`Permanently delete all ${view.totalFiles} item(s) from Trash?`)) {
      return;
    }

    setBusy("empty");
    setNotice(null);
    setErrors([]);

    try {
      const result = await api<RecycleBinDeleteResult>("/recycle-bin", { method: "DELETE" });
      setView(result.recycleBin);
      setSelectedIds({});
      setErrors(result.errors);
      setNotice(`${result.deletedFiles} permanently deleted (${formatBytes(result.deletedBytes)}).`);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel">
      <div className="notice-bar safety">
        <strong>Recycle bin</strong>
        <span>{view?.recycleBinPath || "Loading recycle bin path"}</span>
      </div>
      <div className="toolbar">
        <div className="summary-chips">
          <span>{view?.totalFiles || 0} items</span>
          <span>{formatBytes(view?.totalSize || 0)}</span>
          {filtersActive && <span>{filteredItems.length} shown</span>}
          <span>{selectedItems.length} selected</span>
        </div>
        <div className="search-box">
          <Search size={17} />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter trash" />
        </div>
        <div className="filter-select">
          <SlidersHorizontal size={17} />
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            disabled={items.length === 0}
            aria-label="Filter trash by type"
          >
            {typeOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label} ({option.count.toLocaleString()})
              </option>
            ))}
          </select>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || Boolean(busy)}>
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={restoreSelected}
            disabled={loading || Boolean(busy) || selectedItems.length === 0}
          >
            {busy === "restore" ? <Loader2 className="spin" size={18} /> : <Undo2 size={18} />}
            <span>{busy === "restore" ? "Restoring" : "Restore selected"}</span>
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={deleteSelected}
            disabled={loading || Boolean(busy) || selectedItems.length === 0}
          >
            {busy === "selected" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{busy === "selected" ? "Deleting" : "Delete selected"}</span>
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={emptyTrash}
            disabled={loading || Boolean(busy) || !view?.totalFiles}
          >
            {busy === "empty" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{busy === "empty" ? "Emptying" : "Empty trash"}</span>
          </button>
        </div>
      </div>
      {(loading || busy) && (
        <ActionProgress
          label={
            busy === "restore"
              ? "Restoring recycle bin items"
              : busy
                ? "Deleting recycle bin items"
                : "Loading recycle bin"
          }
        />
      )}
      {notice && <div className="notice-bar">{notice}</div>}
      {errors.length > 0 && (
        <div className="error-list">
          {errors.slice(0, 8).map((error) => (
            <span key={error}>{error}</span>
          ))}
          {errors.length > 8 && <span>{errors.length - 8} more errors</span>}
        </div>
      )}
      {!loading && items.length === 0 ? (
        <EmptyState icon={Trash2} title="Trash is empty" />
      ) : !loading && filteredItems.length === 0 ? (
        <EmptyState icon={Search} title="No matching trash items" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all trash files" />
                </th>
                <th>Deleted</th>
                <th>Original path</th>
                <th>Trash path</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedIds[item.id])}
                      onChange={() => toggleItem(item)}
                      aria-label={`Select ${item.originalRelativePath}`}
                    />
                  </td>
                  <td>
                    <strong>{item.deletedAt ? formatDate(item.deletedAt) : item.deletedGroup || "Unknown"}</strong>
                    <span>{trashItemKindLabel(item)}</span>
                  </td>
                  <td>
                    <span className="path-diff">{item.originalRelativePath}</span>
                  </td>
                  <td>
                    <span className="path-diff">{item.relativePath}</span>
                  </td>
                  <td>{formatBytes(item.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OrganizePage({ stats, onChanged }: { stats: LibraryStats | null; onChanged: () => Promise<void> }) {
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
  const [organizeFilter, setOrganizeFilter] = useState<OrganizePreviewFilter>("attention");
  const [pageIndex, setPageIndex] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [trashBusyKey, setTrashBusyKey] = useState<string | null>(null);
  const [selectedTrashCandidates, setSelectedTrashCandidates] = useState<Record<string, string>>({});
  const previewRequestId = useRef(0);
  const lastScanFinishedAtRef = useRef<string | null | undefined>(undefined);
  const workflow = stats?.workflow;
  const lastScanFinishedAt = stats?.lastScanFinishedAt ?? null;
  const workflowSummary = workflowBlockerSummary(workflow);
  const organizeItems = plan?.items || [];
  const filterCounts = useMemo(() => countOrganizePreviewFilters(organizeItems), [organizeItems]);
  const visibleOrganizeFilters = useMemo(
    () => organizePreviewFilters.filter((filter) => filter.id !== "spotifybu" || filterCounts.spotifybu > 0),
    [filterCounts.spotifybu]
  );
  const filteredItems = useMemo(
    () => organizeItems.filter((item) => organizePreviewItemMatchesFilter(item, organizeFilter)),
    [organizeFilter, organizeItems]
  );
  const selectedTrashSelections = useMemo(
    () => selectedOrganizeTrashSelections(organizeItems, selectedTrashCandidates),
    [organizeItems, selectedTrashCandidates]
  );
  const pageCount = Math.max(1, Math.ceil(filteredItems.length / organizePreviewPageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const pageStart = currentPage * organizePreviewPageSize;
  const pageItems = filteredItems.slice(pageStart, pageStart + organizePreviewPageSize);
  const firstVisibleItem = filteredItems.length === 0 ? 0 : pageStart + 1;
  const lastVisibleItem = Math.min(filteredItems.length, pageStart + pageItems.length);
  const pageRangeLabel =
    filteredItems.length === 0
      ? "0 of 0"
      : `${firstVisibleItem.toLocaleString()}-${lastVisibleItem.toLocaleString()} of ${filteredItems.length.toLocaleString()}`;

  const showPlan = (nextPlan: OrganizePlan) => {
    setPlan(nextPlan);
    setPageIndex(0);
    setOrganizeFilter((current) => selectOrganizeFilterAfterRefresh(current, nextPlan));
    setSelectedTrashCandidates((current) => pruneSelectedTrashCandidates(nextPlan.items, current));
  };

  const load = async ({
    clearNotice = true,
    quick = false,
    resetPlan = false
  }: { clearNotice?: boolean; quick?: boolean; resetPlan?: boolean } = {}) => {
    const requestId = previewRequestId.current + 1;
    previewRequestId.current = requestId;
    setPreviewBusy(true);
    if (resetPlan) {
      setPlan(null);
      setPageIndex(0);
      setSelectedTrashCandidates({});
    }
    if (clearNotice) {
      setNotice(null);
      setApplyErrors([]);
    }

    try {
      const path = quick ? "/organize/preview?quick=1" : `/organize/preview?refresh=${Date.now()}`;
      const nextPlan = await api<OrganizePlan>(path, { method: "POST" });
      if (requestId === previewRequestId.current) {
        showPlan(nextPlan);
        await onChanged();
      }
    } catch (caught) {
      if (requestId === previewRequestId.current) {
        setNotice((caught as Error).message);
      }
    } finally {
      if (requestId === previewRequestId.current) {
        setPreviewBusy(false);
      }
    }
  };

  useEffect(() => {
    void load({ quick: true });
  }, []);

  useEffect(() => {
    const previousScanFinishedAt = lastScanFinishedAtRef.current;
    lastScanFinishedAtRef.current = lastScanFinishedAt;

    if (previousScanFinishedAt === undefined || previousScanFinishedAt === lastScanFinishedAt || !lastScanFinishedAt) {
      return;
    }

    void load({ clearNotice: false, quick: true, resetPlan: true });
  }, [lastScanFinishedAt]);

  const apply = async () => {
    if (!plan?.summary.ready || !window.confirm(`Move ${plan.summary.ready} files?`)) {
      return;
    }

    setApplyBusy(true);
    previewRequestId.current += 1;
    setPreviewBusy(false);
    setNotice(null);
    setApplyErrors([]);
    try {
      const result = await api<OrganizeApplyResult>("/organize/apply", { method: "POST" });
      const errorSuffix = result.errors.length ? `, ${result.errors.length} errors` : "";
      setNotice(`${result.moved} moved, ${result.skipped} skipped${errorSuffix}. Preview refreshed.`);
      setApplyErrors(result.errors);

      await load({ clearNotice: false, resetPlan: true });
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setApplyBusy(false);
    }
  };

  const trashSelectedCandidates = async () => {
    if (selectedTrashSelections.length === 0) {
      return;
    }

    if (!window.confirm(`Move ${selectedTrashSelections.length} selected file(s) to the recycle bin?`)) {
      return;
    }

    setTrashBusyKey("bulk");
    previewRequestId.current += 1;
    setPreviewBusy(false);
    setNotice(null);
    setApplyErrors([]);

    try {
      const result = await api<OrganizeTrashResult>("/organize/trash/bulk", {
        method: "POST",
        body: JSON.stringify({ selections: selectedTrashSelections })
      });
      const errorSuffix = result.errors.length ? `, ${result.errors.length} errors` : "";
      setNotice(`${result.trashed} moved to recycle bin${errorSuffix}. Preview refreshed.`);
      setApplyErrors(result.errors);
      await load({ clearNotice: false, resetPlan: true });
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setTrashBusyKey(null);
    }
  };

  return (
    <section className="panel">
      <div className="notice-bar safety">
        <strong>Organization review</strong>
        <span>Preview moves, conflicts, and missing files. Duplicate cleanup opens automatically once organization is clear.</span>
      </div>
      <div className="toolbar">
        <div className="summary-chips">
          {plan ? (
            <>
              <span>{plan.summary.ready} ready</span>
              <span>{plan.summary.same} organized</span>
              {filterCounts.spotifybu > 0 && <span>{filterCounts.spotifybu} SpotifyBU</span>}
              <span>{plan.summary.duplicateTargets} duplicates</span>
              <span>{plan.summary.conflicts} conflicts</span>
              <span>{plan.summary.missing} missing</span>
              <span>{selectedTrashSelections.length} selected</span>
            </>
          ) : workflow?.stage === "organize" ? (
            <>
              <span>{workflow.pendingMoves} {pluralize("move", workflow.pendingMoves)}</span>
              <span>{workflow.organizationConflicts} {pluralize("conflict", workflow.organizationConflicts)}</span>
              <span>{workflow.missingFiles} missing</span>
              <span>Preview needed</span>
            </>
          ) : workflow?.duplicateScanReady ? (
            <span>Organization clear</span>
          ) : (
            <span>{previewBusy ? "Previewing" : "Preview needed"}</span>
          )}
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load({ resetPlan: true })} disabled={previewBusy || applyBusy || Boolean(trashBusyKey)}>
            {previewBusy ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{previewBusy ? "Previewing" : "Preview"}</span>
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={trashSelectedCandidates}
            disabled={previewBusy || applyBusy || Boolean(trashBusyKey) || selectedTrashSelections.length === 0}
          >
            {trashBusyKey ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{trashBusyKey ? "Moving" : "Trash selected"}</span>
          </button>
          <button className="primary-button" type="button" onClick={apply} disabled={previewBusy || applyBusy || Boolean(trashBusyKey) || !plan?.summary.ready}>
            {applyBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            <span>{applyBusy ? "Applying" : "Apply"}</span>
          </button>
        </div>
      </div>
      {(previewBusy || applyBusy || trashBusyKey) && (
        <ActionProgress
          label={trashBusyKey ? "Moving selected files to recycle bin" : applyBusy ? "Applying organization plan" : "Building organization preview"}
        />
      )}
      {notice && <div className="notice-bar">{notice}</div>}
      {plan?.warnings?.length ? (
        <div className="notice-bar safety">
          <strong>Organizer</strong>
          {plan.warnings.slice(0, 3).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
          {plan.warnings.length > 3 && <span>{plan.warnings.length - 3} more warnings</span>}
        </div>
      ) : null}
      {applyErrors.length > 0 && (
        <div className="error-list">
          {applyErrors.slice(0, 8).map((error) => (
            <span key={error}>{error}</span>
          ))}
          {applyErrors.length > 8 && <span>{applyErrors.length - 8} more errors</span>}
        </div>
      )}
      {!previewBusy && !plan && (
        <EmptyState
          icon={notice ? CircleAlert : FolderInput}
          title={notice ? "Preview failed" : organizePreviewEmptyTitle(workflow)}
          description={notice || organizePreviewEmptyDescription(workflow, workflowSummary)}
        />
      )}
      {plan && (
        <>
          <div className="organize-preview-tools">
            <div className="segmented-control organize-filter" role="radiogroup" aria-label="Preview status">
              {visibleOrganizeFilters.map((filter) => (
                <button
                  key={filter.id}
                  className={organizeFilter === filter.id ? "active" : ""}
                  type="button"
                  role="radio"
                  aria-checked={organizeFilter === filter.id}
                  onClick={() => {
                    setOrganizeFilter(filter.id);
                    setPageIndex(0);
                  }}
                >
                  <span>{filter.label}</span>
                  <strong>{filterCounts[filter.id].toLocaleString()}</strong>
                </button>
              ))}
            </div>
            <div className="pagination-controls" aria-label="Preview pages">
              <button
                className="icon-button"
                type="button"
                onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                disabled={currentPage === 0}
                title="Previous page"
              >
                <ChevronLeft size={18} />
              </button>
              <span>{pageRangeLabel}</span>
              <button
                className="icon-button"
                type="button"
                onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
                disabled={currentPage >= pageCount - 1}
                title="Next page"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
          {filteredItems.length === 0 ? (
            <EmptyState
              icon={Check}
              title={organizeItems.length === 0 ? "No tracks to organize" : "No items in this filter"}
              description={
                organizeItems.length === 0
                  ? "Scan the library to load tracks before organizing."
                  : "Switch filters to see organized tracks, ready moves, or duplicate-target candidates."
              }
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Change</th>
                    <th>Source</th>
                    <th>Target</th>
                    <th>Resolve</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <StatusPill active={item.status === "ready"} label={organizeChangeLabel(item)} />
                        {item.status !== "ready" && item.status !== "same" && (
                          <span className="status-detail">{item.message}</span>
                        )}
                        {item.status === "same" && item.managedBy === "spotifybu" && (
                          <span className="status-detail">{item.message}</span>
                        )}
                      </td>
                      <td>
                        <PathDiff value={item.sourceRelativePath} compareTo={item.targetRelativePath} />
                      </td>
                      <td>
                        {item.targetRelativePath ? (
                          <>
                            <PathDiff value={item.targetRelativePath} compareTo={item.sourceRelativePath} />
                            <span className="status-detail">{organizeMetadataSourceLabel(item)}</span>
                            {organizeNavidromeDiagnosticLabel(item) && (
                              <span className="status-detail navidrome-diagnostic">
                                {organizeNavidromeDiagnosticLabel(item)}
                              </span>
                            )}
                          </>
                        ) : (
                          item.message
                        )}
                      </td>
                      <td>
                        {item.collision ? (
                          <CollisionCandidates
                            item={item}
                            disabled={Boolean(trashBusyKey)}
                            selectedCandidateId={selectedTrashCandidates[item.id] || ""}
                            onSelect={(candidate) => {
                              setSelectedTrashCandidates((current) => {
                                if (!candidate) {
                                  const { [item.id]: _removed, ...next } = current;
                                  return next;
                                }

                                return {
                                  ...current,
                                  [item.id]: candidate.id
                                };
                              });
                            }}
                          />
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function CollisionCandidates({
  item,
  disabled,
  selectedCandidateId,
  onSelect
}: {
  item: OrganizePreviewItem;
  disabled: boolean;
  selectedCandidateId: string;
  onSelect: (candidate: OrganizeCollisionCandidate | null) => void;
}) {
  const candidates = item.collision?.candidates || [];

  return (
    <div className="collision-candidates">
      {candidates.map((candidate) => {
        const selected = selectedCandidateId === candidate.id;

        return (
          <label className="collision-candidate" key={candidate.id}>
            <input
              type="checkbox"
              checked={selected}
              disabled={disabled}
              onChange={() => onSelect(selected ? null : candidate)}
            />
            <div>
              <strong>{collisionRoleLabel(candidate)}</strong>
              <span>{candidate.relativePath}</span>
              <span>{qualitySummary(candidate)}</span>
            </div>
          </label>
        );
      })}
    </div>
  );
}

function DiscoverPage() {
  const [query, setQuery] = useState("");
  const [artists, setArtists] = useState<SpotifyArtistSummary[]>([]);
  const [discography, setDiscography] = useState<SpotifyArtistDiscography | null>(null);
  const [album, setAlbum] = useState<SpotifyAlbumDetail | null>(null);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Record<string, boolean>>({});
  const [downloadPreview, setDownloadPreview] = useState<SpotifyCatalogDownloadPreviewResult | null>(null);
  const [downloadJob, setDownloadJob] = useState<SpotifyCatalogDownloadJob | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [bulkRiskAccepted, setBulkRiskAccepted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const selectedMissingTrackIds = album?.tracks
    .filter((track) => selectedTrackIds[track.id] && !track.present)
    .map((track) => track.id) ?? [];
  const canStartDownload = Boolean(
    album &&
      downloadPreview?.downloadableCount &&
      rightsConfirmed &&
      bulkRiskAccepted &&
      !isCatalogDownloadJobActive(downloadJob) &&
      busy !== "download-preview" &&
      busy !== "download-start"
  );

  useEffect(() => {
    if (!downloadJob || !isCatalogDownloadJobActive(downloadJob)) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void loadDownloadJob(downloadJob.id);
    }, 2500);

    return () => window.clearInterval(interval);
  }, [downloadJob?.id, downloadJob?.status]);

  const searchArtists = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }

    setBusy("search");
    setNotice(null);
    clearDownloadState();

    try {
      const result = await api<{ artists: SpotifyArtistSummary[] }>(
        `/spotify/artists/search?query=${encodeURIComponent(query.trim())}`
      );
      setArtists(result.artists);
      setDiscography(null);
      setAlbum(null);
      setSelectedTrackIds({});
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const loadDiscography = async (artist: SpotifyArtistSummary) => {
    setBusy(`artist:${artist.id}`);
    setNotice(null);
    clearDownloadState();

    try {
      setDiscography(await api<SpotifyArtistDiscography>(`/spotify/artists/${artist.id}/discography`));
      setAlbum(null);
      setSelectedTrackIds({});
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const loadAlbum = async (albumId: string) => {
    setBusy(`album:${albumId}`);
    setNotice(null);
    clearDownloadState();

    try {
      const result = await api<{ album: SpotifyAlbumDetail }>(`/spotify/albums/${albumId}`);
      const nextSelection = Object.fromEntries(
        result.album.tracks.filter((track) => !track.present).map((track) => [track.id, true])
      );

      setAlbum(result.album);
      setSelectedTrackIds(nextSelection);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const prepareDownloadPreview = async () => {
    if (!album || selectedMissingTrackIds.length === 0) {
      return;
    }

    const albumId = album.id;
    const trackIds = [...selectedMissingTrackIds];
    const batches = chunkItems(trackIds, providerPreviewBatchSize);
    setBusy("download-preview");
    setNotice(`Searching providers: 0 of ${trackIds.length} tracks checked.`);
    setDownloadPreview(null);
    setDownloadJob(null);

    try {
      let combinedPreview: SpotifyCatalogDownloadPreviewResult | null = null;

      for (const [batchIndex, batchTrackIds] of batches.entries()) {
        setNotice(
          `Searching provider batch ${batchIndex + 1} of ${batches.length}: ${combinedPreview?.items.length ?? 0} of ${trackIds.length} tracks checked.`
        );
        const result = await api<{ preview: SpotifyCatalogDownloadPreviewResult }>("/spotify/download-preview", {
          method: "POST",
          body: JSON.stringify({ spotifyAlbumId: albumId, trackIds: batchTrackIds })
        });
        combinedPreview = mergeProviderPreviews(combinedPreview, result.preview);
        setDownloadPreview(combinedPreview);
        setNotice(
          `Searching providers: ${combinedPreview.items.length} of ${trackIds.length} tracks checked; ${combinedPreview.downloadableCount} ready.`
        );
      }

      if (!combinedPreview) {
        throw new Error("No tracks were selected for provider search.");
      }
      setNotice(
        combinedPreview.downloadableCount > 0
          ? `Found provider candidates for ${combinedPreview.downloadableCount} of ${combinedPreview.items.length} selected tracks.`
          : `No provider candidates were found for ${combinedPreview.items.length} selected tracks.`
      );
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const startDownloadJob = async () => {
    if (!album) {
      return;
    }

    setBusy("download-start");
    setNotice(null);

    try {
      const result = await api<{ job: SpotifyCatalogDownloadJob; preview: SpotifyCatalogDownloadPreviewResult }>(
        "/spotify/download-jobs",
        {
          method: "POST",
          body: JSON.stringify({
            bulkRiskAccepted,
            reviewedCandidates: downloadPreview?.items
              .filter((item) => item.selectedCandidate)
              .map((item) => ({ candidate: item.selectedCandidate, trackId: item.track.id })),
            rightsConfirmed,
            spotifyAlbumId: album.id,
            trackIds: selectedMissingTrackIds
          })
        }
      );

      setDownloadPreview(result.preview);
      setDownloadJob(result.job);
      setNotice(`Download job started with ${result.job.pendingCount} queued track${result.job.pendingCount === 1 ? "" : "s"}.`);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const loadDownloadJob = async (jobId: string) => {
    try {
      const result = await api<{ job: SpotifyCatalogDownloadJob }>(
        `/spotify/download-jobs/${encodeURIComponent(jobId)}`
      );

      setDownloadJob(result.job);

      if (isCatalogDownloadJobTerminal(result.job)) {
        setNotice(
          `Download job ${result.job.status}: ${result.job.completedCount} completed, ${result.job.failedCount} failed.`
        );

        if (album) {
          const refreshed = await api<{ album: SpotifyAlbumDetail }>(`/spotify/albums/${album.id}`);
          setAlbum(refreshed.album);
          setSelectedTrackIds(
            Object.fromEntries(refreshed.album.tracks.filter((track) => !track.present).map((track) => [track.id, true]))
          );
        }
      }
    } catch (caught) {
      setNotice((caught as Error).message);
    }
  };

  function clearDownloadState() {
    setDownloadPreview(null);
    setDownloadJob(null);
    setRightsConfirmed(false);
    setBulkRiskAccepted(false);
  }

  return (
    <section className="panel discover-panel">
      <form className="toolbar" onSubmit={searchArtists}>
        <label className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Spotify artists"
          />
        </label>
        <button className="primary-button" type="submit" disabled={busy === "search" || !query.trim()}>
          {busy === "search" ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
          <span>{busy === "search" ? "Searching" : "Search"}</span>
        </button>
      </form>

      {notice && <div className="notice-bar">{notice}</div>}
      <div className="notice-bar safety">
        <strong>Spotify catalog</strong>
        <span>Spotify supplies metadata and artwork only. Provider downloads must be content you are authorized to download.</span>
      </div>

      {artists.length > 0 && (
        <div className="catalog-grid">
          {artists.map((artist) => (
            <button
              className="catalog-card"
              key={artist.id}
              onClick={() => loadDiscography(artist)}
              type="button"
            >
              {artist.imageUrl ? <img alt="" src={artist.imageUrl} /> : <Music2 size={28} />}
              <span>
                <strong>{artist.name}</strong>
                <em>{busy === `artist:${artist.id}` ? "Loading" : "View discography"}</em>
              </span>
            </button>
          ))}
        </div>
      )}

      {discography && (
        <div className="settings-subsection">
          <span className="subsection-label">{discography.artist.name}</span>
          <div className="catalog-grid albums">
            {discography.albums.map((candidate) => (
              <button
                className="catalog-card"
                key={candidate.id}
                onClick={() => loadAlbum(candidate.id)}
                type="button"
              >
                {candidate.imageUrl ? <img alt="" src={candidate.imageUrl} /> : <AlbumIcon size={28} />}
                <span>
                  <strong>{candidate.name}</strong>
                  <em>
                    {candidate.releaseYear || "Unknown year"} - {candidate.localTrackCount}/{candidate.totalTracks} local
                  </em>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {album && (
        <div className="table-wrap catalog-tracks">
          <div className="toolbar compact-toolbar">
            <div>
              <span className="eyebrow">{album.artist.name}</span>
              <h2>{album.name}</h2>
            </div>
            <button
              className="primary-button"
              type="button"
              onClick={prepareDownloadPreview}
              disabled={busy === "download-preview" || selectedMissingTrackIds.length === 0}
            >
              {busy === "download-preview" ? <Loader2 className="spin" size={18} /> : <Search size={18} />}
              <span>
                {busy === "download-preview"
                  ? `Finding ${downloadPreview?.items.length ?? 0}/${selectedMissingTrackIds.length}`
                  : "Find sources"}
              </span>
            </button>
          </div>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>#</th>
                <th>Track</th>
                <th>Status</th>
                <th>Length</th>
              </tr>
            </thead>
            <tbody>
              {album.tracks.map((track) => (
                <tr className={track.present ? "" : "catalog-missing"} key={track.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selectedTrackIds[track.id])}
                      disabled={track.present}
                      onChange={(event) =>
                        setSelectedTrackIds((current) => ({
                          ...current,
                          [track.id]: event.target.checked
                        }))
                      }
                    />
                  </td>
                  <td>{track.discNumber}-{track.trackNumber}</td>
                  <td>{track.name}</td>
                  <td>{track.present ? "Local" : "Missing"}</td>
                  <td>{formatDuration(track.duration)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {downloadPreview && (
        <div className="download-preview">
          <div className="toolbar compact-toolbar">
            <div>
              <span className="eyebrow">Provider preview</span>
              <h2>
                {busy === "download-preview"
                  ? `${downloadPreview.items.length}/${selectedMissingTrackIds.length} checked · ${downloadPreview.downloadableCount} ready`
                  : `${downloadPreview.downloadableCount}/${downloadPreview.items.length} ready`}
              </h2>
            </div>
            <button
              className="primary-button"
              type="button"
              onClick={startDownloadJob}
              disabled={!canStartDownload}
            >
              {busy === "download-start" ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              <span>{busy === "download-start" ? "Starting" : "Download"}</span>
            </button>
          </div>
          <div className="download-confirmations">
            <label>
              <input
                checked={rightsConfirmed}
                disabled={isCatalogDownloadJobActive(downloadJob)}
                onChange={(event) => setRightsConfirmed(event.target.checked)}
                type="checkbox"
              />
              <span>I am authorized to download the selected tracks.</span>
            </label>
            <label>
              <input
                checked={bulkRiskAccepted}
                disabled={isCatalogDownloadJobActive(downloadJob)}
                onChange={(event) => setBulkRiskAccepted(event.target.checked)}
                type="checkbox"
              />
              <span>I accept provider throttling and bulk-download risk.</span>
            </label>
          </div>
          {downloadPreview.warnings.map((warning) => (
            <div className="notice-bar safety" key={warning}>{warning}</div>
          ))}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Target</th>
                  <th>Provider</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                {downloadPreview.items.map((item) => {
                  const candidate = item.selectedCandidate;

                  return (
                    <tr key={item.track.id}>
                      <td>
                        <strong>{item.track.name}</strong>
                        <span>{item.track.artists.join(", ")}</span>
                      </td>
                      <td>{item.targetRelativePath}</td>
                      <td>
                        {candidate ? (
                          <>
                            <span className="provider-pill">{providerLabel(candidate.providerId)}</span>
                            <span>{candidate.title}</span>
                          </>
                        ) : (
                          item.error || "No source found"
                        )}
                      </td>
                      <td>
                        {candidate ? (
                          <>
                            <strong>{candidate.score.overall}%</strong>
                            <span>{formatProviderDuration(candidate.durationMs)}</span>
                          </>
                        ) : (
                          "Missing"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {downloadJob && (
        <div className="download-preview">
          <div className="toolbar compact-toolbar">
            <div>
              <span className="eyebrow">Download job</span>
              <h2>{downloadJob.status}</h2>
            </div>
            {isCatalogDownloadJobActive(downloadJob) && <Loader2 className="spin" size={22} />}
          </div>
          <div className="status-row">
            <span>{downloadJob.completedCount} completed</span>
            <span>{downloadJob.pendingCount} pending</span>
            <span>{downloadJob.failedCount} failed</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Status</th>
                  <th>Destination</th>
                </tr>
              </thead>
              <tbody>
                {downloadJob.items.map((item) => (
                  <tr key={item.track.id}>
                    <td>{item.track.name}</td>
                    <td>{item.error || item.status}</td>
                    <td>{item.relativePath || item.targetRelativePath}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

function SettingsPage({
  advancedDiagnosticsEnabled,
  onAuthChange
}: {
  advancedDiagnosticsEnabled: boolean;
  onAuthChange: (auth: AuthInfo) => void;
}) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [navidromePassword, setNavidromePassword] = useState("");
  const [spotifyClientSecret, setSpotifyClientSecret] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [navidromeBusy, setNavidromeBusy] = useState(false);
  const [spotifyBusy, setSpotifyBusy] = useState(false);

  useEffect(() => {
    api<SettingsView>("/settings")
      .then(setSettings)
      .catch((caught) => setNotice((caught as Error).message));
  }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) {
      return;
    }

    setBusy(true);
    setNotice(null);

    try {
      let next = await api<SettingsView>("/settings", {
        method: "PUT",
        body: JSON.stringify({
          auth: {
            ...settings.auth,
            password: adminPassword
          },
          navidrome: {
            baseUrl: settings.navidrome.baseUrl,
            username: settings.navidrome.username,
            password: navidromePassword
          },
          catalog: {
            spotify: {
              clientId: settings.catalog.spotify.clientId,
              clientSecret: spotifyClientSecret,
              market: settings.catalog.spotify.market
            },
            providers: settings.catalog.providers,
            discovery: settings.catalog.discovery
          },
          naming: {
            mode: "standard",
            libraryPath: settings.naming.libraryPath,
            recycleBinPath: settings.naming.recycleBinPath
          },
          scan: settings.scan,
          cleanup: settings.cleanup
        })
      });

      setSettings(next);
      setAdminPassword("");
      setNavidromePassword("");
      setSpotifyClientSecret("");
      onAuthChange({
        advancedDiagnosticsEnabled,
        authEnabled: next.auth.enabled,
        authenticated: true,
        username: next.auth.username
      });
      setNotice("Saved");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    if (!settings) {
      return;
    }

    setNavidromeBusy(true);
    setNotice(null);

    try {
      const result = await api<{ ok: boolean; message: string }>("/navidrome/test", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: settings.navidrome.baseUrl,
          username: settings.navidrome.username,
          password: navidromePassword
        })
      });
      setNotice(result.message);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setNavidromeBusy(false);
    }
  };

  const testSpotify = async () => {
    if (!settings) {
      return;
    }

    setSpotifyBusy(true);
    setNotice(null);

    try {
      const result = await api<{ ok: boolean; message: string }>("/spotify/test", {
        method: "POST",
        body: JSON.stringify({
          clientId: settings.catalog.spotify.clientId,
          clientSecret: spotifyClientSecret,
          market: settings.catalog.spotify.market
        })
      });
      setNotice(result.message);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setSpotifyBusy(false);
    }
  };

  if (!settings) {
    return <MessageScreen title="Settings" message="Loading" />;
  }

  return (
    <form className="settings-grid" onSubmit={save}>
      {notice && <div className="notice-bar settings-notice">{notice}</div>}
      {busy && <ActionProgress label="Saving settings" />}
      {navidromeBusy && <ActionProgress label="Testing Navidrome connection" />}
      {spotifyBusy && <ActionProgress label="Testing Spotify catalog connection" />}

      <fieldset className="panel">
        <legend>
          <Shield size={18} />
          Auth
        </legend>
        <label className="toggle-row">
          <span>Built-in auth</span>
          <input
            type="checkbox"
            checked={settings.auth.enabled}
            onChange={(event) =>
              setSettings({ ...settings, auth: { ...settings.auth, enabled: event.target.checked } })
            }
          />
        </label>
        <label>
          Admin username
          <input
            value={settings.auth.username}
            onChange={(event) =>
              setSettings({ ...settings, auth: { ...settings.auth, username: event.target.value } })
            }
          />
        </label>
        <label>
          Admin password
          <input value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} type="password" />
        </label>
      </fieldset>

      <fieldset className="panel">
        <legend>
          <SlidersHorizontal size={18} />
          Navidrome
        </legend>
        <label>
          URL
          <input
            value={settings.navidrome.baseUrl}
            onChange={(event) =>
              setSettings({ ...settings, navidrome: { ...settings.navidrome, baseUrl: event.target.value } })
            }
            placeholder="http://navidrome:4533"
          />
        </label>
        <label>
          Username
          <input
            value={settings.navidrome.username}
            onChange={(event) =>
              setSettings({ ...settings, navidrome: { ...settings.navidrome, username: event.target.value } })
            }
          />
        </label>
        <label>
          Password
          <input
            value={navidromePassword}
            onChange={(event) => setNavidromePassword(event.target.value)}
            type="password"
            placeholder={settings.navidrome.passwordSet ? "Saved" : ""}
          />
        </label>
        <button className="secondary-button" type="button" onClick={testConnection} disabled={navidromeBusy}>
          {navidromeBusy ? <Loader2 className="spin" size={18} /> : <Activity size={18} />}
          <span>{navidromeBusy ? "Testing" : "Test"}</span>
        </button>
      </fieldset>

      <fieldset className="panel">
        <legend>
          <Music2 size={18} />
          Spotify catalog
        </legend>
        <label>
          Client ID
          <input
            value={settings.catalog.spotify.clientId}
            onChange={(event) =>
              setSettings({
                ...settings,
                catalog: {
                  ...settings.catalog,
                  spotify: { ...settings.catalog.spotify, clientId: event.target.value }
                }
              })
            }
          />
        </label>
        <label>
          Client secret
          <input
            value={spotifyClientSecret}
            onChange={(event) => setSpotifyClientSecret(event.target.value)}
            type="password"
            placeholder={settings.catalog.spotify.clientSecretSet ? "Saved" : ""}
          />
        </label>
        <label>
          Market
          <input
            value={settings.catalog.spotify.market}
            maxLength={2}
            onChange={(event) =>
              setSettings({
                ...settings,
                catalog: {
                  ...settings.catalog,
                  spotify: { ...settings.catalog.spotify, market: event.target.value.toUpperCase() }
                }
              })
            }
            placeholder="US"
          />
        </label>
        <label>
          Spotify requests per minute
          <input
            min={10}
            max={60}
            type="number"
            value={settings.catalog.discovery.requestsPerMinute}
            onChange={(event) =>
              setSettings({
                ...settings,
                catalog: {
                  ...settings.catalog,
                  discovery: {
                    ...settings.catalog.discovery,
                    requestsPerMinute: Number(event.target.value)
                  }
                }
              })
            }
          />
        </label>
        <button className="secondary-button" type="button" onClick={testSpotify} disabled={spotifyBusy}>
          {spotifyBusy ? <Loader2 className="spin" size={18} /> : <Activity size={18} />}
          <span>{spotifyBusy ? "Testing" : "Test"}</span>
        </button>
      </fieldset>

      <fieldset className="panel">
        <legend>
          <Download size={18} />
          Provider downloads
        </legend>
        <label>
          Opus quality cap
          <select
            value={settings.catalog.providers.opusQuality}
            onChange={(event) => setSettings({
              ...settings,
              catalog: {
                ...settings.catalog,
                providers: {
                  ...settings.catalog.providers,
                  opusQuality: Number(event.target.value) as 160 | 192 | 256
                }
              }
            })}
          >
            <option value={160}>160 kbps</option>
            <option value={192}>192 kbps (default)</option>
            <option value={256}>256 kbps</option>
          </select>
        </label>
        <label>
          MP3 fallback quality
          <select
            value={settings.catalog.providers.mp3FallbackEnabled
              ? settings.catalog.providers.mp3FallbackQuality
              : "off"}
            onChange={(event) => {
              const enabled = event.target.value !== "off";
              setSettings({
                ...settings,
                catalog: {
                  ...settings.catalog,
                  providers: {
                    ...settings.catalog.providers,
                    mp3FallbackEnabled: enabled,
                    mp3FallbackQuality: enabled
                      ? Number(event.target.value) as 192 | 256 | 320
                      : settings.catalog.providers.mp3FallbackQuality
                  }
                }
              });
            }}
          >
            <option value="off">Off</option>
            <option value={192}>192 kbps</option>
            <option value={256}>256 kbps</option>
            <option value={320}>320 kbps (default)</option>
          </select>
        </label>
        <div className="notice-bar safety">
          <strong>Quality values are maximums</strong>
          <span>Provider audio below the selected cap stays at its source bitrate and is not upconverted.</span>
        </div>
      </fieldset>

      <fieldset className="panel wide-settings">
        <legend>
          <FolderInput size={18} />
          Library
        </legend>
        <label>
          Library path
          <input
            value={settings.naming.libraryPath}
            onChange={(event) =>
              setSettings({ ...settings, naming: { ...settings.naming, libraryPath: event.target.value } })
            }
          />
        </label>
        <label>
          Recycle bin path
          <input
            value={settings.naming.recycleBinPath}
            onChange={(event) =>
              setSettings({ ...settings, naming: { ...settings.naming, recycleBinPath: event.target.value } })
            }
          />
        </label>
        <div className="notice-bar safety">
          <strong>NaviClean naming</strong>
          <span>Uses Spotify album metadata in the standard Artist / Album (Year) layout.</span>
        </div>
        <label className="toggle-row">
          <span>Daily auto scan</span>
          <input
            type="checkbox"
            checked={settings.scan.autoScanEnabled}
            onChange={(event) =>
              setSettings({
                ...settings,
                scan: { ...settings.scan, autoScanEnabled: event.target.checked }
              })
            }
          />
        </label>
        <label>
          Auto scan time
          <input
            type="time"
            value={settings.scan.autoScanTime}
            disabled={!settings.scan.autoScanEnabled}
            onChange={(event) =>
              setSettings({
                ...settings,
                scan: { ...settings.scan, autoScanTime: event.target.value }
              })
            }
          />
        </label>
        <div className="settings-subsection">
          <span className="subsection-label">Empty folder exclusions</span>
          {settings.cleanup.emptyFolderExclusions.length === 0 ? (
            <span className="muted">No excluded folders</span>
          ) : (
            <div className="settings-list">
              {settings.cleanup.emptyFolderExclusions.map((relativePath) => (
                <div className="settings-list-row" key={relativePath}>
                  <span className="path-diff">{relativePath}</span>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() =>
                      setSettings({
                        ...settings,
                        cleanup: {
                          ...settings.cleanup,
                          emptyFolderExclusions: settings.cleanup.emptyFolderExclusions.filter((item) => item !== relativePath)
                        }
                      })
                    }
                  >
                    <Check size={17} />
                    <span>Include</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      <div className="settings-actions">
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
          <span>Save</span>
        </button>
      </div>
    </form>
  );
}

function PathDiff({ value, compareTo }: { value: string; compareTo: string }) {
  return (
    <span className="path-diff">
      {diffText(value, compareTo).map((part, index) =>
        part.changed ? (
          <mark key={`${index}-${part.text}`}>{part.text}</mark>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        )
      )}
    </span>
  );
}

function initialTheme(): AppTheme {
  let stored: string | null = null;

  try {
    stored = window.localStorage.getItem(themeStorageKey);
  } catch {
    stored = null;
  }

  if (stored === "light" || stored === "dark") {
    return stored;
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ActionProgress({ label }: { label: string }) {
  return (
    <div className="action-progress" role="status" aria-live="polite">
      <div className="action-progress-label">
        <Loader2 className="spin" size={16} />
        <span>{label}</span>
      </div>
      <div className="progress-track" role="progressbar" aria-label={label}>
        <span />
      </div>
    </div>
  );
}

function DeterminateProgress({ label, value }: { label: string; value: number }) {
  const progress = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className="action-progress determinate" role="status" aria-live="polite">
      <div className="action-progress-label">
        <span>{label}</span>
        <strong>{progress}%</strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

function organizePreviewEmptyTitle(workflow?: LibraryStats["workflow"]) {
  if (!workflow) {
    return "Run organization preview";
  }

  if (workflow.stage === "organize") {
    return "Preview needed to review organization";
  }

  if (workflow.duplicateScanReady) {
    return "Organization clear";
  }

  return workflow.scanned ? "Scan status changed" : "Scan library first";
}

function organizePreviewEmptyDescription(workflow?: LibraryStats["workflow"], blockerSummary = "") {
  if (!workflow) {
    return "Preview checks the library for moves, conflicts, and missing files before duplicate cleanup.";
  }

  if (workflow.stage === "organize") {
    return blockerSummary
      ? `NaviClean found ${blockerSummary}. Generate the preview to review and apply the organization plan.`
      : "Generate the preview to review the current organization plan.";
  }

  if (workflow.duplicateScanReady) {
    return "There are no pending moves, conflicts, or missing files. You can check duplicate cleanup.";
  }

  return workflow.scanned
    ? "Refresh after the current scan settles, then generate an organization preview."
    : "Scan the library before generating an organization preview.";
}

function duplicateGateNoticeTitle(workflow?: LibraryStats["workflow"]) {
  if (!workflow) {
    return "Duplicate cleanup unavailable";
  }

  if (workflow.stage === "scan") {
    return workflow.scanned ? "Duplicates waiting on scan" : "Duplicates need a library scan";
  }

  return "Duplicates waiting on organization";
}

function duplicateGateEmptyTitle(workflow?: LibraryStats["workflow"]) {
  if (!workflow) {
    return "Duplicate cleanup not ready";
  }

  if (workflow.stage === "scan") {
    return workflow.scanned ? "Scan still running" : "Scan library first";
  }

  return "Organization needs attention";
}

function duplicateGateEmptyDescription(workflow?: LibraryStats["workflow"]) {
  if (!workflow) {
    return "Refresh stats, then review scan and organization status.";
  }

  if (workflow.stage === "scan") {
    return workflow.scanned
      ? "Duplicate cleanup unlocks after the current scan finishes and organization is clear."
      : "Scan the library, then review organization before checking duplicates.";
  }

  return "Review the organizer; duplicates unlock once moves, conflicts, and missing files are clear.";
}

function workflowBlockerSummary(workflow?: LibraryStats["workflow"]) {
  if (!workflow || workflow.stage !== "organize") {
    return "";
  }

  return [
    countWorkflowItem(workflow.pendingMoves, "move"),
    countWorkflowItem(workflow.organizationConflicts, "conflict"),
    countWorkflowItem(workflow.missingFiles, "missing file")
  ].filter(Boolean).join(", ");
}

function countWorkflowItem(count: number, noun: string) {
  if (count <= 0) {
    return "";
  }

  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function EmptyState({ icon: Icon, title, description }: { icon: typeof Database; title: string; description?: string }) {
  return (
    <div className="empty-state">
      <Icon size={24} />
      <strong>{title}</strong>
      {description && <span>{description}</span>}
    </div>
  );
}

function MessageScreen({ title, message }: { title: string; message: string }) {
  const loading = message.toLowerCase().includes("loading");

  return (
    <main className="message-screen">
      {loading ? <Loader2 className="spin" size={24} /> : <CircleAlert size={24} />}
      <h1>{title}</h1>
      <p>{message}</p>
    </main>
  );
}

function VersionFooter() {
  return (
    <footer className="version-footer">
      <span>Version {appVersion.version}</span>
      <span>Branch {appVersion.branch}</span>
    </footer>
  );
}

function StatusPill({ active, label }: { active: boolean; label: string }) {
  return <span className={active ? "status-pill active" : "status-pill"}>{label}</span>;
}

function organizeMetadataSourceLabel(item: OrganizePreviewItem) {
  if (item.targetSource === "navidrome") {
    return item.navidromeEnrichment?.matchMethod
      ? `Navidrome metadata (${navidromeMatchMethodLabel(item.navidromeEnrichment.matchMethod)})`
      : "Navidrome metadata";
  }

  if (item.targetSource === "spotify") {
    return "Spotify metadata";
  }

  if (item.status === "same" && item.sourceRelativePath === item.targetRelativePath) {
    return "Path-organized/local metadata";
  }

  return "Local metadata";
}

function organizeNavidromeDiagnosticLabel(item: OrganizePreviewItem) {
  const diagnostic = item.navidromeEnrichment;

  if (!diagnostic || diagnostic.code === "matched") {
    return "";
  }

  return diagnostic.message;
}

function navidromeMatchMethodLabel(method: NonNullable<OrganizePreviewItem["navidromeEnrichment"]>["matchMethod"]) {
  if (method === "absolute-path") {
    return "absolute path";
  }

  if (method === "relative-path") {
    return "relative path";
  }

  if (method === "filename-size") {
    return "filename+size";
  }

  if (method === "metadata-size-relaxed-duration") {
    return "metadata+size";
  }

  if (method === "edition-metadata-size") {
    return "edition metadata+size";
  }

  if (method === "metadata-size-title-suffix") {
    return "metadata+size title suffix";
  }

  if (method === "edition-title-suffix-metadata-size") {
    return "edition+title suffix metadata+size";
  }

  if (method === "metadata-size-track-agnostic") {
    return "metadata+size no track";
  }

  if (method === "metadata-size-artist-agnostic") {
    return "metadata+size no artist";
  }

  return "metadata key";
}

function countOrganizePreviewFilters(items: OrganizePreviewItem[]) {
  const counts: Record<OrganizePreviewFilter, number> = {
    attention: 0,
    ready: 0,
    "duplicate-target": 0,
    conflict: 0,
    missing: 0,
    spotifybu: 0,
    same: 0,
    all: 0
  };

  for (const item of items) {
    counts.all += 1;

    if (item.managedBy === "spotifybu") {
      counts.spotifybu += 1;
    }

    if (item.status === "same") {
      counts.same += 1;
    } else if (item.status === "duplicate-target") {
      counts["duplicate-target"] += 1;
    } else {
      counts.attention += 1;
    }

    if (item.status === "ready") {
      counts.ready += 1;
    }

    if (item.status === "conflict" || item.status === "outside-library") {
      counts.conflict += 1;
    }

    if (item.status === "missing-source") {
      counts.missing += 1;
    }
  }

  return counts;
}

function organizePreviewItemMatchesFilter(item: OrganizePreviewItem, filter: OrganizePreviewFilter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "attention") {
    return item.status !== "same" && item.status !== "duplicate-target";
  }

  if (filter === "conflict") {
    return item.status === "conflict" || item.status === "outside-library";
  }

  if (filter === "missing") {
    return item.status === "missing-source";
  }

  if (filter === "spotifybu") {
    return item.managedBy === "spotifybu";
  }

  return item.status === filter;
}

function selectOrganizeFilterAfterRefresh(current: OrganizePreviewFilter, plan: OrganizePlan) {
  const counts = countOrganizePreviewFilters(plan.items);

  if (counts[current] > 0) {
    return current;
  }

  if (counts.attention > 0) {
    return "attention";
  }

  return "all";
}

function selectedOrganizeTrashSelections(
  items: OrganizePreviewItem[],
  selectedCandidates: Record<string, string>
): OrganizeTrashSelection[] {
  return Object.entries(selectedCandidates)
    .filter(([itemId, candidateId]) => itemHasCollisionCandidate(items, itemId, candidateId))
    .map(([itemId, candidateId]) => ({ itemId, candidateId }));
}

function pruneSelectedTrashCandidates(items: OrganizePreviewItem[], selectedCandidates: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(selectedCandidates).filter(([itemId, candidateId]) =>
      itemHasCollisionCandidate(items, itemId, candidateId)
    )
  );
}

function itemHasCollisionCandidate(items: OrganizePreviewItem[], itemId: string, candidateId: string) {
  return Boolean(
    items.find((item) =>
      item.id === itemId && item.collision?.candidates.some((candidate) => candidate.id === candidateId)
    )
  );
}

function pruneSelectedDuplicateTrashIds(groups: DuplicateGroup[], selectedIds: Record<string, boolean>) {
  const validIds = new Set(groups.flatMap((group) => group.tracks.map((track) => track.id)));
  const next = Object.fromEntries(
    Object.entries(selectedIds).filter(([id, selected]) => selected && validIds.has(id))
  );

  for (const group of groups) {
    const selectedTracks = group.tracks.filter((track) => next[track.id]);

    if (selectedTracks.length >= group.tracks.length) {
      delete next[selectedTracks.at(-1)?.id || ""];
    }
  }

  return next;
}

function duplicateTrashSelectionWouldRemoveGroup(
  group: DuplicateGroup,
  selectedIds: Record<string, boolean>,
  toggledTrackId: string
) {
  return group.tracks.every((track) => track.id === toggledTrackId || selectedIds[track.id]);
}

function organizeChangeLabel(item: OrganizePlan["items"][number]) {
  if (item.status === "same") {
    if (item.managedBy === "spotifybu") {
      return "SpotifyBU";
    }

    return "Already organized";
  }

  if (item.status === "conflict") {
    return "Conflict";
  }

  if (item.status === "duplicate-target") {
    return "Duplicate target";
  }

  if (item.status === "outside-library") {
    return "Blocked";
  }

  if (item.status === "missing-source") {
    return "Missing source";
  }

  if (item.sourceRelativePath === item.targetRelativePath) {
    return "Ready";
  }

  const sourceDir = pathDirectory(item.sourceRelativePath);
  const targetDir = pathDirectory(item.targetRelativePath);
  const sourceName = pathFilename(item.sourceRelativePath);
  const targetName = pathFilename(item.targetRelativePath);

  if (sourceDir === targetDir && sourceName !== targetName) {
    return "Rename file";
  }

  if (sourceDir !== targetDir && sourceName === targetName) {
    return "Move folder";
  }

  return "Move + rename";
}

function StagePill({ active, complete, label }: { active: boolean; complete: boolean; label: string }) {
  return <span className={complete ? "stage-pill complete" : active ? "stage-pill active" : "stage-pill"}>{label}</span>;
}

function pathDirectory(value: string) {
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index >= 0 ? value.slice(0, index) : "";
}

function pathFilename(value: string) {
  const index = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return index >= 0 ? value.slice(index + 1) : value;
}

function filterLibraryTracks(tracks: TrackFile[], search: string) {
  const query = search.trim().toLowerCase();

  if (!query) {
    return tracks;
  }

  return tracks.filter((track) =>
    [track.title, track.artist, track.albumArtist, track.album, track.relativePath]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
}

function countUnindexedFilters(tracks: TrackFile[]): Record<UnindexedFilter, number> {
  return {
    all: tracks.length,
    "possible-stale-scan": tracks.filter((track) => track.navidromeEnrichment?.code === "possible-stale-scan").length,
    "no-api-match": tracks.filter((track) => track.navidromeEnrichment?.code === "no-api-match").length
  };
}

function unindexedTrackMatchesFilter(track: TrackFile, filter: UnindexedFilter, search: string) {
  if (filter !== "all" && track.navidromeEnrichment?.code !== filter) {
    return false;
  }

  const query = search.trim().toLowerCase();

  if (!query) {
    return true;
  }

  return [
    track.title,
    track.artist,
    track.albumArtist,
    track.album,
    track.relativePath,
    track.extension,
    track.codec || "",
    track.container || "",
    track.navidromeEnrichment?.message || ""
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

function unindexedReasonShortLabel(track: TrackFile) {
  if (track.navidromeEnrichment?.code === "possible-stale-scan") {
    return "Organized local";
  }

  if (track.navidromeEnrichment?.code === "no-api-match") {
    return "No API match";
  }

  return "Unindexed";
}

function unindexedTrackSummary(track: TrackFile) {
  return libraryMeta([
    track.artist,
    track.album,
    albumReleaseLabel(track),
    trackNumberLabel(track),
    track.duration ? formatDuration(track.duration) : "",
    formatBytes(track.size),
    track.isrc ? `ISRC ${track.isrc}` : ""
  ]);
}

function unindexedCandidateSummary(candidate: UnindexedNavidromeCandidate) {
  return libraryMeta([
    candidate.navidrome.artist,
    candidate.navidrome.album,
    candidate.navidrome.year ? String(candidate.navidrome.year) : "",
    [
      candidate.navidrome.discNumber ? `D${candidate.navidrome.discNumber}` : "",
      candidate.navidrome.trackNumber ? `T${candidate.navidrome.trackNumber}` : ""
    ].filter(Boolean).join(" "),
    candidate.navidrome.duration ? formatDuration(candidate.navidrome.duration) : "",
    candidate.navidrome.size ? formatBytes(candidate.navidrome.size) : "",
    candidate.navidrome.isrc ? `ISRC ${candidate.navidrome.isrc}` : "",
    navidromePathStatusLabel(candidate)
  ]);
}

function navidromePathStatusLabel(candidate: UnindexedNavidromeCandidate) {
  if (candidate.navidrome.pathStatus === "missing") {
    return "No API path";
  }

  if (candidate.navidrome.pathStatus === "outside-library-root") {
    return "Path outside library root";
  }

  return "";
}

function unindexedCheckLabel(label: string, status: UnindexedNavidromeCandidate["checks"][keyof UnindexedNavidromeCandidate["checks"]]) {
  if (status === "match") {
    return `${label}: match`;
  }

  if (status === "unavailable") {
    return `${label}: unavailable`;
  }

  return `${label}: differs`;
}

function libraryTrashNotice(result: LibraryTrashResult) {
  const errorSuffix = result.errors.length ? ` (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})` : "";
  return `${result.trashed} moved to recycle bin${errorSuffix}.`;
}

function nonMusicTrashNotice(result: NonMusicTrashResult) {
  const errorSuffix = result.errors.length ? ` (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})` : "";
  return `${result.trashed.toLocaleString()} non-music ${pluralize("file", result.trashed)} moved to trash (${formatBytes(result.trashedBytes)})${errorSuffix}.`;
}

function emptyFolderDeleteNotice(result: EmptyFolderDeleteResult) {
  const errorSuffix = result.errors.length ? ` (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})` : "";
  const nextPass = result.emptyFolders.total;
  return `${result.deleted} empty ${pluralize("folder", result.deleted)} moved to Trash${errorSuffix}. ${nextPass} in the next pass.`;
}

function nonMusicClassificationLabel(value: NonMusicFileClassification) {
  if (value === "useful") {
    return "Likely useful";
  }

  if (value === "junk") {
    return "Probably junk";
  }

  return "Review";
}

function buildTrashTypeOptions(items: RecycleBinItem[]) {
  const options = new Map<string, { key: string; label: string; count: number; rank: number }>();

  for (const item of items) {
    const type = trashItemType(item);
    const option = options.get(type.key) ?? { ...type, count: 0 };
    option.count += 1;
    options.set(type.key, option);
  }

  return [
    { key: "all", label: "All types", count: items.length, rank: -1 },
    ...Array.from(options.values()).sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label))
  ];
}

function filterTrashItems(items: RecycleBinItem[], filter: string, typeFilter: string) {
  const query = filter.trim().toLowerCase();

  return items.filter((item) =>
    trashItemMatchesType(item, typeFilter) &&
    (!query ||
      [item.originalRelativePath, item.relativePath, item.deletedGroup, item.extension]
        .join(" ")
        .toLowerCase()
        .includes(query))
  );
}

function filterAudioConvertFiles(files: AudioConvertFile[], search: string) {
  const query = search.trim().toLowerCase();

  if (!query) {
    return files;
  }

  return files.filter((file) =>
    [file.relativePath, file.title, file.artist, file.album, file.extension]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
}

function trashItemMatchesType(item: RecycleBinItem, typeFilter: string) {
  return typeFilter === "all" || trashItemType(item).key === typeFilter;
}

function trashItemType(item: RecycleBinItem) {
  if (item.itemType === "folder") {
    return { key: "folder", label: "Folders", rank: 0 };
  }

  const extension = item.extension.toLowerCase();

  if (trashAudioExtensions.has(extension)) {
    return { key: "audio", label: "Audio files", rank: 1 };
  }

  if (trashArtworkExtensions.has(extension)) {
    return { key: "artwork", label: "Artwork/images", rank: 2 };
  }

  if (trashMetadataExtensions.has(extension)) {
    return { key: "metadata", label: "Metadata/review", rank: 3 };
  }

  if (trashPlaylistExtensions.has(extension)) {
    return { key: "playlist", label: "Playlists", rank: 4 };
  }

  if (trashLyricsExtensions.has(extension)) {
    return { key: "lyrics", label: "Lyrics", rank: 5 };
  }

  if (trashArchiveExtensions.has(extension)) {
    return { key: "archive", label: "Archives", rank: 6 };
  }

  if (trashVideoExtensions.has(extension)) {
    return { key: "video", label: "Video files", rank: 7 };
  }

  if (trashJunkExtensions.has(extension)) {
    return { key: "junk", label: "Temporary/junk", rank: 8 };
  }

  if (!extension) {
    return { key: "extensionless", label: "No extension", rank: 9 };
  }

  return { key: "other", label: "Other files", rank: 10 };
}

function trashItemKindLabel(item: RecycleBinItem) {
  if (item.itemType === "folder") {
    return "Folder";
  }

  return item.extension.replace(".", "").toUpperCase() || "File";
}

function libraryMeta(values: string[]) {
  return values.filter(Boolean).join(" / ");
}

function navidromeScanTypeLabel(value?: string | null) {
  switch (value) {
    case "quick":
      return "Quick scan";
    case "full":
      return "Full scan";
    case "quick-selective":
      return "Quick selective scan";
    case "full-selective":
      return "Full selective scan";
    default:
      return value ? value.replaceAll("-", " ") : "No scan type";
  }
}

function navidromeScanActionLabel(value?: string | null) {
  return value ? navidromeScanTypeLabel(value) : "Scan";
}

function issueLabel(count: number) {
  return count > 0 ? `${count} metadata ${count === 1 ? "issue" : "issues"}` : "";
}

function pluralize(value: string, count: number) {
  return count === 1 ? value : `${value}s`;
}

function trackNumberLabel(track: TrackFile) {
  const trackNumber = track.trackNumber ? track.trackNumber.toString().padStart(2, "0") : "--";

  if (track.discNumber && track.discNumber > 1) {
    return `${track.discNumber}-${trackNumber}`;
  }

  return trackNumber;
}

function albumReleaseLabel(track: TrackFile) {
  return [track.albumType, track.year || "Unknown Year", track.album].filter(Boolean).join(" - ");
}

function collisionRoleLabel(candidate: OrganizeCollisionCandidate) {
  if (candidate.role === "source") {
    return "Source file";
  }

  if (candidate.role === "existing-target") {
    return "Existing target";
  }

  return "Same target";
}

function qualitySummary(file: TrackFile | OrganizeCollisionCandidate) {
  const extension = file.extension ? file.extension.replace(".", "").toUpperCase() : "FILE";
  const qualityParts = [
    extension,
    file.lossless ? "lossless" : "",
    file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : "",
    file.sampleRate ? `${Math.round(file.sampleRate / 1000)}kHz` : "",
    file.bitsPerSample ? `${file.bitsPerSample}-bit` : "",
    file.duration ? formatDuration(file.duration) : "",
    typeof file.size === "number" ? formatBytes(file.size) : "",
    typeof file.qualityScore === "number" ? `score ${Math.round(file.qualityScore)}` : ""
  ];

  return qualityParts.filter(Boolean).join(" / ");
}

function diffText(value: string, compareTo: string) {
  if (!compareTo || value === compareTo) {
    return [{ text: value, changed: false }];
  }

  let start = 0;
  while (start < value.length && start < compareTo.length && value[start] === compareTo[start]) {
    start += 1;
  }

  let valueEnd = value.length - 1;
  let compareEnd = compareTo.length - 1;
  while (valueEnd >= start && compareEnd >= start && value[valueEnd] === compareTo[compareEnd]) {
    valueEnd -= 1;
    compareEnd -= 1;
  }

  return [
    { text: value.slice(0, start), changed: false },
    { text: value.slice(start, valueEnd + 1), changed: true },
    { text: value.slice(valueEnd + 1), changed: false }
  ].filter((part) => part.text.length > 0);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatScanDate(value: string) {
  return Number.isFinite(Date.parse(value)) ? formatDate(value) : value;
}

function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(value: number) {
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatProviderDuration(value?: number) {
  return typeof value === "number" ? formatDuration(value / 1000) : "Unknown length";
}

function providerLabel(value: string) {
  return value === "jiosaavn" ? "JioSaavn" : "YouTube";
}

export function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function mergeProviderPreviews(
  current: SpotifyCatalogDownloadPreviewResult | null,
  next: SpotifyCatalogDownloadPreviewResult
): SpotifyCatalogDownloadPreviewResult {
  if (!current) {
    return next;
  }

  return {
    album: current.album,
    downloadableCount: current.downloadableCount + next.downloadableCount,
    failedCount: current.failedCount + next.failedCount,
    generatedAt: next.generatedAt,
    items: [...current.items, ...next.items],
    warnings: Array.from(new Set([...current.warnings, ...next.warnings]))
  };
}

function isCatalogDownloadJobActive(job: SpotifyCatalogDownloadJob | null) {
  return job?.status === "queued" || job?.status === "running";
}

function isCatalogDownloadJobTerminal(job: SpotifyCatalogDownloadJob) {
  return job.status === "completed" || job.status === "failed";
}

function isAudioConvertJobActive(job: AudioConvertJob | null) {
  return job?.status === "queued" || job?.status === "running";
}

function audioConvertJobProgress(job: AudioConvertJob) {
  if (job.totalCount <= 0) {
    return 0;
  }

  const totalProgress = job.items.reduce((total, item) => {
    if (item.status === "completed" || item.status === "failed") {
      return total + 100;
    }

    return total + item.progress;
  }, 0);

  return totalProgress / job.totalCount;
}

function audioConvertJobNotice(job: AudioConvertJob) {
  const converted = `${job.completedCount.toLocaleString()} ${pluralize("file", job.completedCount)} converted`;
  const failed = job.failedCount > 0 ? `, ${job.failedCount.toLocaleString()} failed` : "";

  return `${converted}${failed}.`;
}

function audioConvertJobProgressLabel(job: AudioConvertJob) {
  if (isAudioConvertJobActive(job) && job.pendingCount === 0) {
    return "Refreshing catalog";
  }

  if (isAudioConvertJobActive(job)) {
    return "Converting audio files";
  }

  return audioConvertJobNotice(job);
}

function audioConvertJobStatusLabel(job: AudioConvertJob) {
  if (job.status === "completed") {
    return `Finished ${formatDate(job.completedAt || job.updatedAt)}`;
  }

  if (job.status === "failed") {
    return `Failed ${formatDate(job.completedAt || job.updatedAt)}`;
  }

  if (job.status === "queued") {
    return "Queued";
  }

  return "Running";
}

function audioConvertItemStatusLabel(status: AudioConvertJob["items"][number]["status"]) {
  if (status === "converting") {
    return "Converting";
  }

  if (status === "completed") {
    return "Done";
  }

  if (status === "failed") {
    return "Failed";
  }

  return "Pending";
}

function audioConvertTargetOption(format: AudioConvertTargetFormat) {
  return audioConvertTargetOptions.find((option) => option.id === format);
}

function defaultAudioConvertTarget(sourceExtension: string): AudioConvertTargetFormat {
  return sourceExtension === ".mp3" ? "m4a" : "mp3";
}

function audioConvertQualityOptionsForTarget(targetFormat: AudioConvertTargetFormat) {
  const target = audioConvertTargetOption(targetFormat);

  if (target?.lossless) {
    return [audioConvertLosslessQualityOption];
  }

  return audioConvertLossyQualityOptions;
}

function audioConvertQualityLabel(quality: AudioConvertQuality) {
  const option = [...audioConvertLossyQualityOptions, audioConvertLosslessQualityOption].find(
    (candidate) => candidate.id === quality
  );

  return option ? `${option.label} / ${option.description}` : quality;
}

function audioConvertFileSummary(file: AudioConvertFile) {
  return libraryMeta([
    file.lossless ? "lossless" : "",
    file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : "",
    file.duration ? formatDuration(file.duration) : ""
  ]);
}
