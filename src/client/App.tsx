import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CopyX,
  Database,
  FolderInput,
  Gauge,
  ListChecks,
  Loader2,
  LockKeyhole,
  LogOut,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Trash2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type {
  AuthInfo,
  DuplicateGroup,
  LibraryStats,
  NamingMode,
  OrganizeApplyResult,
  OrganizeCollisionCandidate,
  OrganizePlan,
  OrganizeTrashResult,
  ScanStatus,
  SettingsView,
  TrackFile
} from "../shared/types";
import { api } from "./api";
import { appVersion } from "./version";

type Page = "dashboard" | "library" | "duplicates" | "organize" | "settings";
type OrganizePreviewFilter = "attention" | "ready" | "duplicate-target" | "conflict" | "missing" | "same" | "all";
type OrganizePreviewItem = OrganizePlan["items"][number];

const organizePreviewPageSize = 150;

const navItems: Array<{ id: Page; label: string; icon: typeof Gauge }> = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "library", label: "Library", icon: Database },
  { id: "organize", label: "Organize", icon: FolderInput },
  { id: "duplicates", label: "Duplicates", icon: CopyX },
  { id: "settings", label: "Settings", icon: Settings }
];

const namingModes: Array<{ id: NamingMode; label: string }> = [
  { id: "spotifybu", label: "SpotifyBU" },
  { id: "lidarr", label: "Lidarr" },
  { id: "manual", label: "Manual" }
];

const organizePreviewFilters: Array<{ id: OrganizePreviewFilter; label: string }> = [
  { id: "attention", label: "Needs action" },
  { id: "ready", label: "Ready" },
  { id: "duplicate-target", label: "Duplicates" },
  { id: "conflict", label: "Conflicts" },
  { id: "missing", label: "Missing" },
  { id: "same", label: "Organized" },
  { id: "all", label: "All" }
];

const spotifyBuNamingDefaults = {
  artistFolderFormat: "{Album Artist Name}",
  standardTrackFormat:
    "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
  multiDiscTrackFormat:
    "{Album Artist Name} - {Album Type} - {Release Year} - {Album Title}/{medium:00}{track:00} - {Track Title}",
  replaceIllegalCharacters: true,
  colonReplacementFormat: 4
};

export default function App() {
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return <Shell auth={auth} onAuthChange={setAuth} />;
}

function Shell({ auth, onAuthChange }: { auth: AuthInfo; onAuthChange: (auth: AuthInfo) => void }) {
  const [page, setPage] = useState<Page>("dashboard");
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);

  const loadScanStatus = async () => {
    const nextScan = await api<ScanStatus>("/scan/status");
    setScan(nextScan);
    return nextScan;
  };

  const loadStats = async () => {
    const nextStats = await api<LibraryStats>("/stats");
    setStats(nextStats);
    return nextStats;
  };

  const refreshStats = async () => {
    const nextScan = await loadScanStatus();

    if (!nextScan.running) {
      await loadStats();
    }
  };

  useEffect(() => {
    refreshStats().catch((caught) => setNotice((caught as Error).message));
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
        .catch((caught) => setNotice((caught as Error).message));
    }, 1500);
    return () => window.clearInterval(interval);
  }, [scan?.running]);

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

  const signOut = async () => {
    setSignOutBusy(true);
    setNotice(null);

    try {
      await api<{ ok: boolean }>("/auth/logout", { method: "POST" });
      onAuthChange({ authEnabled: true, authenticated: false, username: null });
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setSignOutBusy(false);
    }
  };

  const active = navItems.find((item) => item.id === page) || navItems[0];

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
          {navItems.map((item) => {
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

        <button className="ghost-button" type="button" onClick={signOut} disabled={signOutBusy} title="Sign out">
          {signOutBusy ? <Loader2 className="spin" size={18} /> : <LogOut size={18} />}
          <span>{signOutBusy ? "Signing out" : "Sign out"}</span>
        </button>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="eyebrow">{active.label}</span>
            <h1>{active.label === "Dashboard" ? "Library Console" : active.label}</h1>
          </div>
          <div className="topbar-actions">
            {notice && <span className="notice">{notice}</span>}
            <button className="primary-button" type="button" onClick={startScan} disabled={scanBusy || scan?.running} title="Scan library">
              {scanBusy || scan?.running ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              <span>{scanBusy || scan?.running ? "Scanning" : "Scan"}</span>
            </button>
          </div>
        </header>

        {page === "dashboard" && <Dashboard stats={stats} scan={scan} />}
        {page === "library" && <LibraryPage />}
        {page === "duplicates" && (
          <DuplicatesPage stats={stats} onChanged={refreshStats} onOpenOrganize={() => setPage("organize")} />
        )}
        {page === "organize" && <OrganizePage onChanged={refreshStats} />}
        {page === "settings" && <SettingsPage onAuthChange={onAuthChange} />}
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

function Dashboard({ stats, scan }: { stats: LibraryStats | null; scan: ScanStatus | null }) {
  const metrics = [
    { label: "Tracks", value: stats?.totalTracks ?? 0, tone: "teal" },
    { label: "Duplicate groups", value: stats?.duplicateGroups ?? 0, tone: "rose" },
    { label: "Pending moves", value: stats?.pendingMoves ?? 0, tone: "amber" },
    { label: "Metadata flags", value: stats?.missingMetadata ?? 0, tone: "ink" }
  ];

  return (
    <section className="content-grid">
      <div className="metric-grid">
        {metrics.map((metric) => (
          <article className={`metric-card ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value.toLocaleString()}</strong>
          </article>
        ))}
      </div>

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

function LibraryPage() {
  const [search, setSearch] = useState("");
  const [tracks, setTracks] = useState<TrackFile[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const handle = window.setTimeout(() => {
      api<{ tracks: TrackFile[]; total: number }>(`/tracks?limit=150&search=${encodeURIComponent(search)}`)
        .then((body) => {
          setTracks(body.tracks);
          setTotal(body.total);
          setError(null);
        })
        .catch((caught) => setError((caught as Error).message))
        .finally(() => setLoading(false));
    }, 180);

    return () => window.clearTimeout(handle);
  }, [search]);

  return (
    <section className="panel">
      <div className="toolbar">
        <div className="search-box">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search" />
        </div>
        <span className="muted">{loading ? "Loading tracks" : `${total.toLocaleString()} tracks`}</span>
      </div>
      {loading && <ActionProgress label="Loading tracks" />}
      {error && <p className="form-error">{error}</p>}
      {!loading && <TrackTable tracks={tracks} />}
    </section>
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
  const [keepIds, setKeepIds] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);

    try {
      const body = await api<{ groups: DuplicateGroup[] }>("/duplicates");
      setGroups(body.groups);
      setKeepIds(Object.fromEntries(body.groups.map((group) => [group.key, group.suggestedKeepId])));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!stats?.workflow.duplicateScanReady) {
      setGroups([]);
      setLoading(false);
      return;
    }

    load().catch((caught) => setNotice((caught as Error).message));
  }, [stats?.workflow.duplicateScanReady]);

  const resolve = async (group: DuplicateGroup) => {
    const keepId = keepIds[group.key] || group.suggestedKeepId;
    const removeIds = group.tracks.filter((track) => track.id !== keepId).map((track) => track.id);

    if (!window.confirm(`Move ${removeIds.length} duplicate file(s) to the recycle bin? Review every path before continuing.`)) {
      return;
    }

    setBusyKey(group.key);
    setNotice(null);

    try {
      const result = await api<{ trashed: number }>("/duplicates/resolve", {
        method: "POST",
        body: JSON.stringify({ keepId, removeIds })
      });
      setNotice(`${result.trashed} moved to recycle bin`);
      await load();
      await onChanged();
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusyKey(null);
    }
  };

  if (!stats?.workflow.duplicateScanReady) {
    return (
      <section className="stack">
        <div className="notice-bar safety">
          <strong>Duplicates locked</strong>
          <span>{stats?.workflow.message || "Scan and organize the library before duplicate cleanup."}</span>
          {stats?.workflow && (
            <span>
              {stats.workflow.pendingMoves} moves, {stats.workflow.organizationConflicts} conflicts, {stats.workflow.missingFiles} missing files
            </span>
          )}
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={onOpenOrganize}>
            <FolderInput size={18} />
            <span>Review blockers</span>
          </button>
        </div>
        <EmptyState icon={LockKeyhole} title="Finish organization first" />
      </section>
    );
  }

  return (
    <section className="stack">
      <div className="notice-bar safety">
        <strong>Review before recycling</strong>
        <span>Only same organized album, disc/track, title/version, and duration matches are shown.</span>
      </div>
      {notice && <div className="notice-bar">{notice}</div>}
      {busyKey && <ActionProgress label="Moving duplicates to recycle bin" />}
      {loading && <ActionProgress label="Loading duplicate groups" />}
      {!loading && groups.length === 0 && <EmptyState icon={Check} title="No duplicate groups" />}
      {groups.map((group) => (
        <article className="panel duplicate-group" key={group.key}>
          <div className="panel-title split">
            <div>
              <h2>{group.tracks[0].title}</h2>
              <span>{group.reason}</span>
            </div>
            <button className="danger-button" type="button" onClick={() => resolve(group)} disabled={busyKey === group.key}>
              {busyKey === group.key ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>Trash others</span>
            </button>
          </div>
          <div className="duplicate-list">
            {group.tracks.map((track) => (
              <label className="duplicate-option" key={track.id}>
                <input
                  type="radio"
                  name={group.key}
                  checked={(keepIds[group.key] || group.suggestedKeepId) === track.id}
                  onChange={() => setKeepIds((current) => ({ ...current, [group.key]: track.id }))}
                />
                <div>
                  <strong>{track.extension.toUpperCase().replace(".", "")} - {track.title}</strong>
                  <span>{albumReleaseLabel(track)}</span>
                  <span>{track.relativePath}</span>
                </div>
                <em>{qualitySummary(track)}</em>
              </label>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function OrganizePage({ onChanged }: { onChanged: () => Promise<void> }) {
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
  const [organizeFilter, setOrganizeFilter] = useState<OrganizePreviewFilter>("attention");
  const [pageIndex, setPageIndex] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [trashBusyKey, setTrashBusyKey] = useState<string | null>(null);
  const organizeItems = plan?.items || [];
  const filterCounts = useMemo(() => countOrganizePreviewFilters(organizeItems), [organizeItems]);
  const filteredItems = useMemo(
    () => organizeItems.filter((item) => organizePreviewItemMatchesFilter(item, organizeFilter)),
    [organizeFilter, organizeItems]
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
  };

  const load = async ({ clearNotice = true }: { clearNotice?: boolean } = {}) => {
    setPreviewBusy(true);
    if (clearNotice) {
      setNotice(null);
      setApplyErrors([]);
    }

    try {
      showPlan(await api<OrganizePlan>("/organize/preview", { method: "POST" }));
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const apply = async () => {
    if (!plan?.summary.ready || !window.confirm(`Move ${plan.summary.ready} files?`)) {
      return;
    }

    setApplyBusy(true);
    setNotice(null);
    setApplyErrors([]);
    try {
      const result = await api<OrganizeApplyResult>("/organize/apply", { method: "POST" });
      const errorSuffix = result.errors.length ? `, ${result.errors.length} errors` : "";
      setNotice(`${result.moved} moved, ${result.skipped} skipped${errorSuffix}. Preview refreshed.`);
      setApplyErrors(result.errors);

      if (result.plan) {
        showPlan(result.plan);
      } else {
        await load({ clearNotice: false });
      }

      await onChanged();
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setApplyBusy(false);
    }
  };

  const trashCandidate = async (item: OrganizePreviewItem, candidate: OrganizeCollisionCandidate) => {
    if (!window.confirm(`Move ${candidate.relativePath} to the recycle bin?`)) {
      return;
    }

    setTrashBusyKey(`${item.id}:${candidate.id}`);
    setNotice(null);
    setApplyErrors([]);

    try {
      const result = await api<OrganizeTrashResult>("/organize/trash", {
        method: "POST",
        body: JSON.stringify({ itemId: item.id, candidateId: candidate.id })
      });
      setNotice(`${result.trashed} moved to recycle bin. Preview refreshed.`);
      showPlan(result.plan);
      await onChanged();
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setTrashBusyKey(null);
    }
  };

  return (
    <section className="panel">
      <div className="notice-bar safety">
        <strong>Stage 2: organize first</strong>
        <span>Files move into the SpotifyBU/Lidarr album layout before duplicate cleanup unlocks.</span>
      </div>
      <div className="toolbar">
        <div className="summary-chips">
          <span>{plan?.summary.ready || 0} ready</span>
          <span>{plan?.summary.same || 0} organized</span>
          <span>{plan?.summary.duplicateTargets || 0} duplicates</span>
          <span>{plan?.summary.conflicts || 0} conflicts</span>
          <span>{plan?.summary.missing || 0} missing</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={previewBusy || applyBusy}>
            {previewBusy ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{previewBusy ? "Previewing" : "Preview"}</span>
          </button>
          <button className="primary-button" type="button" onClick={apply} disabled={previewBusy || applyBusy || !plan?.summary.ready}>
            {applyBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            <span>{applyBusy ? "Applying" : "Apply"}</span>
          </button>
        </div>
      </div>
      {(previewBusy || applyBusy || trashBusyKey) && (
        <ActionProgress
          label={trashBusyKey ? "Moving file to recycle bin" : applyBusy ? "Applying organization plan" : "Building organization preview"}
        />
      )}
      {notice && <div className="notice-bar">{notice}</div>}
      {applyErrors.length > 0 && (
        <div className="error-list">
          {applyErrors.slice(0, 8).map((error) => (
            <span key={error}>{error}</span>
          ))}
          {applyErrors.length > 8 && <span>{applyErrors.length - 8} more errors</span>}
        </div>
      )}
      {!previewBusy && !plan && <EmptyState icon={FolderInput} title="No preview loaded" />}
      {plan && (
        <>
          <div className="organize-preview-tools">
            <div className="segmented-control organize-filter" role="radiogroup" aria-label="Preview status">
              {organizePreviewFilters.map((filter) => (
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
            <EmptyState icon={Check} title="No preview items" />
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
                      </td>
                      <td>
                        <PathDiff value={item.sourceRelativePath} compareTo={item.targetRelativePath} />
                      </td>
                      <td>
                        {item.targetRelativePath ? (
                          <PathDiff value={item.targetRelativePath} compareTo={item.sourceRelativePath} />
                        ) : (
                          item.message
                        )}
                      </td>
                      <td>
                        {item.collision ? (
                          <CollisionCandidates
                            item={item}
                            busyKey={trashBusyKey}
                            onTrash={trashCandidate}
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
  busyKey,
  onTrash
}: {
  item: OrganizePreviewItem;
  busyKey: string | null;
  onTrash: (item: OrganizePreviewItem, candidate: OrganizeCollisionCandidate) => Promise<void>;
}) {
  const candidates = item.collision?.candidates || [];

  return (
    <div className="collision-candidates">
      {candidates.map((candidate) => {
        const candidateBusyKey = `${item.id}:${candidate.id}`;
        const busy = busyKey === candidateBusyKey;

        return (
          <div className="collision-candidate" key={candidate.id}>
            <div>
              <strong>{collisionRoleLabel(candidate)}</strong>
              <span>{candidate.relativePath}</span>
              <span>{qualitySummary(candidate)}</span>
            </div>
            <button
              className="danger-button compact"
              type="button"
              onClick={() => onTrash(item, candidate)}
              disabled={Boolean(busyKey)}
              title={`Move ${candidate.relativePath} to recycle bin`}
            >
              {busy ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
              <span>{busy ? "Moving" : "Trash"}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function SettingsPage({ onAuthChange }: { onAuthChange: (auth: AuthInfo) => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [navidromePassword, setNavidromePassword] = useState("");
  const [lidarrApiKey, setLidarrApiKey] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [navidromeBusy, setNavidromeBusy] = useState(false);
  const [lidarrBusy, setLidarrBusy] = useState(false);

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
          naming: {
            mode: settings.naming.mode,
            libraryPath: settings.naming.libraryPath,
            recycleBinPath: settings.naming.recycleBinPath,
            artistFolderFormat: settings.naming.artistFolderFormat,
            standardTrackFormat: settings.naming.standardTrackFormat,
            multiDiscTrackFormat: settings.naming.multiDiscTrackFormat,
            replaceIllegalCharacters: settings.naming.replaceIllegalCharacters,
            colonReplacementFormat: settings.naming.colonReplacementFormat,
            lidarr: {
              baseUrl: settings.naming.lidarr.baseUrl,
              apiKey: lidarrApiKey
            }
          }
        })
      });

      let message = "Saved";

      if (next.naming.mode === "lidarr") {
        next = await api<SettingsView>("/lidarr/naming/sync", {
          method: "POST",
          body: JSON.stringify({
            baseUrl: next.naming.lidarr.baseUrl,
            apiKey: lidarrApiKey
          })
        });
        message = "Saved and loaded Lidarr naming";
      }

      setSettings(next);
      setAdminPassword("");
      setNavidromePassword("");
      setLidarrApiKey("");
      onAuthChange({
        authEnabled: next.auth.enabled,
        authenticated: true,
        username: next.auth.username
      });
      setNotice(message);
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

  const updateNaming = (update: Partial<SettingsView["naming"]>) => {
    if (!settings) {
      return;
    }
    setSettings({ ...settings, naming: { ...settings.naming, ...update } });
  };

  const updateLidarr = (update: Partial<SettingsView["naming"]["lidarr"]>) => {
    if (!settings) {
      return;
    }
    updateNaming({ lidarr: { ...settings.naming.lidarr, ...update } });
  };

  const testLidarr = async () => {
    if (!settings) {
      return;
    }

    setLidarrBusy(true);
    setNotice(null);
    try {
      const result = await api<{ ok: boolean; message: string }>("/lidarr/test", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: settings.naming.lidarr.baseUrl,
          apiKey: lidarrApiKey
        })
      });
      setNotice(result.message);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setLidarrBusy(false);
    }
  };

  const loadLidarrNaming = async () => {
    if (!settings) {
      return;
    }

    setLidarrBusy(true);
    setNotice(null);
    try {
      const next = await api<SettingsView>("/lidarr/naming/sync", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: settings.naming.lidarr.baseUrl,
          apiKey: lidarrApiKey
        })
      });
      setSettings(next);
      setLidarrApiKey("");
      setNotice("Loaded Lidarr naming");
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setLidarrBusy(false);
    }
  };

  if (!settings) {
    return <MessageScreen title="Settings" message="Loading" />;
  }

  const canEditFormats = settings.naming.mode === "manual";

  return (
    <form className="settings-grid" onSubmit={save}>
      {notice && <div className="notice-bar settings-notice">{notice}</div>}
      {busy && <ActionProgress label="Saving settings" />}
      {navidromeBusy && <ActionProgress label="Testing Navidrome connection" />}
      {lidarrBusy && <ActionProgress label="Contacting Lidarr" />}

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
        <div className="settings-subsection">
          <span className="subsection-label">Naming source</span>
          <div className="segmented-control" role="radiogroup" aria-label="Naming source">
            {namingModes.map((mode) => (
              <button
                key={mode.id}
                className={settings.naming.mode === mode.id ? "active" : ""}
                type="button"
                role="radio"
                aria-checked={settings.naming.mode === mode.id}
                onClick={() =>
                  updateNaming(mode.id === "spotifybu" ? { mode: mode.id, ...spotifyBuNamingDefaults } : { mode: mode.id })
                }
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        {settings.naming.mode === "lidarr" && (
          <div className="settings-subsection">
            <div className="form-grid two">
              <label>
                Lidarr URL
                <input
                  value={settings.naming.lidarr.baseUrl}
                  onChange={(event) => updateLidarr({ baseUrl: event.target.value })}
                  placeholder="http://lidarr:8686"
                />
              </label>
              <label>
                Lidarr API key
                <input
                  value={lidarrApiKey}
                  onChange={(event) => setLidarrApiKey(event.target.value)}
                  type="password"
                  placeholder={settings.naming.lidarr.apiKeySet ? "Saved" : ""}
                />
              </label>
            </div>
            <div className="button-row">
              <button className="secondary-button" type="button" onClick={testLidarr} disabled={lidarrBusy}>
                {lidarrBusy ? <Loader2 className="spin" size={18} /> : <Activity size={18} />}
                <span>Test</span>
              </button>
              <button className="secondary-button" type="button" onClick={loadLidarrNaming} disabled={lidarrBusy}>
                {lidarrBusy ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
                <span>Load from Lidarr</span>
              </button>
            </div>
          </div>
        )}
        {settings.naming.mode === "spotifybu" && (
          <div className="notice-bar safety">
            <strong>SpotifyBU naming</strong>
            <span>This fixed mode keeps NaviClean aligned with SpotifyBU for fresh installs and rescans.</span>
          </div>
        )}
        {settings.naming.mode === "manual" && (
          <div className="notice-bar safety">
            <strong>Manual naming</strong>
            <span>Preview organization before applying moves.</span>
          </div>
        )}
        <div className="form-grid two">
          <label>
            Artist folder
            <input
              value={settings.naming.artistFolderFormat}
              readOnly={!canEditFormats}
              onChange={(event) => updateNaming({ artistFolderFormat: event.target.value })}
            />
          </label>
          <label>
            Standard track
            <input
              value={settings.naming.standardTrackFormat}
              readOnly={!canEditFormats}
              onChange={(event) => updateNaming({ standardTrackFormat: event.target.value })}
            />
          </label>
        </div>
        <label>
          Multi-disc track
          <input
            value={settings.naming.multiDiscTrackFormat}
            readOnly={!canEditFormats}
            onChange={(event) => updateNaming({ multiDiscTrackFormat: event.target.value })}
          />
        </label>
        <label className="toggle-row">
          <span>Replace illegal characters</span>
          <input
            type="checkbox"
            checked={settings.naming.replaceIllegalCharacters}
            disabled={!canEditFormats}
            onChange={(event) => updateNaming({ replaceIllegalCharacters: event.target.checked })}
          />
        </label>
        <label>
          Colon replacement
          <select
            value={settings.naming.colonReplacementFormat}
            disabled={!canEditFormats}
            onChange={(event) => updateNaming({ colonReplacementFormat: Number(event.target.value) })}
          >
            <option value={4}>Smart</option>
            <option value={0}>Delete</option>
            <option value={1}>Dash</option>
            <option value={2}>Space dash</option>
            <option value={3}>Space dash space</option>
          </select>
        </label>
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

function TrackTable({ tracks }: { tracks: TrackFile[] }) {
  if (tracks.length === 0) {
    return <EmptyState icon={Database} title="No tracks" />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Track</th>
            <th>Album</th>
            <th>Current path</th>
            <th>Target path</th>
            <th>Quality</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => (
            <tr key={track.id}>
              <td>
                <strong>{track.title}</strong>
                <span>{track.artist}</span>
              </td>
              <td>{track.album}</td>
              <td>{track.relativePath}</td>
              <td>{track.targetRelativePath}</td>
              <td>
                <span className="quality-pill">
                  {qualitySummary(track)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function EmptyState({ icon: Icon, title }: { icon: typeof Database; title: string }) {
  return (
    <div className="empty-state">
      <Icon size={24} />
      <strong>{title}</strong>
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

function countOrganizePreviewFilters(items: OrganizePreviewItem[]) {
  const counts: Record<OrganizePreviewFilter, number> = {
    attention: 0,
    ready: 0,
    "duplicate-target": 0,
    conflict: 0,
    missing: 0,
    same: 0,
    all: 0
  };

  for (const item of items) {
    counts.all += 1;

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

function organizeChangeLabel(item: OrganizePlan["items"][number]) {
  if (item.status === "same") {
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

