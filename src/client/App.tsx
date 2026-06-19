import {
  Activity,
  Check,
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
  OrganizePlan,
  ScanStatus,
  SettingsView,
  TrackFile
} from "../shared/types";
import { api } from "./api";
import { appVersion } from "./version";

type Page = "dashboard" | "library" | "duplicates" | "organize" | "settings";

const navItems: Array<{ id: Page; label: string; icon: typeof Gauge }> = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "library", label: "Library", icon: Database },
  { id: "organize", label: "Organize", icon: FolderInput },
  { id: "duplicates", label: "Duplicates", icon: CopyX },
  { id: "settings", label: "Settings", icon: Settings }
];

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

  const refreshStats = async () => {
    const [nextScan, nextStats] = await Promise.all([
      api<ScanStatus>("/scan/status"),
      api<LibraryStats>("/stats")
    ]);
    setScan(nextScan);
    setStats(nextStats);
  };

  useEffect(() => {
    refreshStats().catch((caught) => setNotice((caught as Error).message));
  }, []);

  useEffect(() => {
    if (!scan?.running) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      refreshStats().catch((caught) => setNotice((caught as Error).message));
    }, 1500);
    return () => window.clearInterval(interval);
  }, [scan?.running]);

  const startScan = async () => {
    setNotice(null);
    const next = await api<ScanStatus>("/scan/start", { method: "POST" });
    setScan(next);
  };

  const signOut = async () => {
    await api<{ ok: boolean }>("/auth/logout", { method: "POST" });
    onAuthChange({ authEnabled: true, authenticated: false, username: null });
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

        <button className="ghost-button" type="button" onClick={signOut} title="Sign out">
          <LogOut size={18} />
          <span>Sign out</span>
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
            <button className="primary-button" type="button" onClick={startScan} disabled={scan?.running} title="Scan library">
              {scan?.running ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              <span>{scan?.running ? "Scanning" : "Scan"}</span>
            </button>
          </div>
        </header>

        {page === "dashboard" && <Dashboard stats={stats} scan={scan} />}
        {page === "library" && <LibraryPage />}
        {page === "duplicates" && <DuplicatesPage stats={stats} onChanged={refreshStats} />}
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

  useEffect(() => {
    const handle = window.setTimeout(() => {
      api<{ tracks: TrackFile[]; total: number }>(`/tracks?limit=150&search=${encodeURIComponent(search)}`)
        .then((body) => {
          setTracks(body.tracks);
          setTotal(body.total);
          setError(null);
        })
        .catch((caught) => setError((caught as Error).message));
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
        <span className="muted">{total.toLocaleString()} tracks</span>
      </div>
      {error && <p className="form-error">{error}</p>}
      <TrackTable tracks={tracks} />
    </section>
  );
}

function DuplicatesPage({ stats, onChanged }: { stats: LibraryStats | null; onChanged: () => Promise<void> }) {
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [keepIds, setKeepIds] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    const body = await api<{ groups: DuplicateGroup[] }>("/duplicates");
    setGroups(body.groups);
    setKeepIds(Object.fromEntries(body.groups.map((group) => [group.key, group.suggestedKeepId])));
  };

  useEffect(() => {
    if (!stats?.workflow.duplicateScanReady) {
      setGroups([]);
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
      {groups.length === 0 && <EmptyState icon={Check} title="No duplicate groups" />}
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
                  <strong>{track.extension.toUpperCase().replace(".", "")} · {track.title}</strong>
                  <span>{track.albumType} · {track.year || "Unknown Year"} · {track.album}</span>
                  <span>{track.relativePath}</span>
                </div>
                <em>{formatBytes(track.size)}</em>
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
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setPlan(await api<OrganizePlan>("/organize/preview", { method: "POST" }));
  };

  useEffect(() => {
    load().catch((caught) => setNotice((caught as Error).message));
  }, []);

  const apply = async () => {
    if (!plan?.summary.ready || !window.confirm(`Move ${plan.summary.ready} files?`)) {
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const result = await api<{ moved: number; skipped: number; errors: string[] }>("/organize/apply", { method: "POST" });
      setNotice(`${result.moved} moved, ${result.skipped} skipped`);
      await load();
      await onChanged();
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(false);
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
          <span>{plan?.summary.conflicts || 0} conflicts</span>
          <span>{plan?.summary.missing || 0} missing</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={load}>
            <RefreshCw size={18} />
            <span>Preview</span>
          </button>
          <button className="primary-button" type="button" onClick={apply} disabled={busy || !plan?.summary.ready}>
            {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            <span>Apply</span>
          </button>
        </div>
      </div>
      {notice && <div className="notice-bar">{notice}</div>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Source</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {(plan?.items || []).slice(0, 150).map((item) => (
              <tr key={item.id}>
                <td>
                  <StatusPill active={item.status === "ready"} label={item.status} />
                </td>
                <td>{item.sourceRelativePath}</td>
                <td>{item.targetRelativePath || item.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SettingsPage({ onAuthChange }: { onAuthChange: (auth: AuthInfo) => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [adminPassword, setAdminPassword] = useState("");
  const [navidromePassword, setNavidromePassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      const next = await api<SettingsView>("/settings", {
        method: "PUT",
        body: JSON.stringify({
          ...settings,
          auth: {
            ...settings.auth,
            password: adminPassword
          },
          navidrome: {
            baseUrl: settings.navidrome.baseUrl,
            username: settings.navidrome.username,
            password: navidromePassword
          }
        })
      });
      setSettings(next);
      setAdminPassword("");
      setNavidromePassword("");
      onAuthChange({
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
    setNotice(null);
    const result = await api<{ ok: boolean; message: string }>("/navidrome/test", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: settings.navidrome.baseUrl,
        username: settings.navidrome.username,
        password: navidromePassword
      })
    });
    setNotice(result.message);
  };

  if (!settings) {
    return <MessageScreen title="Settings" message="Loading" />;
  }

  return (
    <form className="settings-grid" onSubmit={save}>
      {notice && <div className="notice-bar settings-notice">{notice}</div>}

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
        <button className="secondary-button" type="button" onClick={testConnection}>
          <Activity size={18} />
          <span>Test</span>
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
        <div className="form-grid two">
          <label>
            Artist folder
            <input
              value={settings.naming.artistFolderFormat}
              onChange={(event) =>
                setSettings({ ...settings, naming: { ...settings.naming, artistFolderFormat: event.target.value } })
              }
            />
          </label>
          <label>
            Standard track
            <input
              value={settings.naming.standardTrackFormat}
              onChange={(event) =>
                setSettings({ ...settings, naming: { ...settings.naming, standardTrackFormat: event.target.value } })
              }
            />
          </label>
        </div>
        <label>
          Multi-disc track
          <input
            value={settings.naming.multiDiscTrackFormat}
            onChange={(event) =>
              setSettings({ ...settings, naming: { ...settings.naming, multiDiscTrackFormat: event.target.value } })
            }
          />
        </label>
        <label className="toggle-row">
          <span>Replace illegal characters</span>
          <input
            type="checkbox"
            checked={settings.naming.replaceIllegalCharacters}
            onChange={(event) =>
              setSettings({
                ...settings,
                naming: { ...settings.naming, replaceIllegalCharacters: event.target.checked }
              })
            }
          />
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
                  {track.extension.replace(".", "").toUpperCase()} {track.bitrate ? `${Math.round(track.bitrate / 1000)}k` : ""}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
  return (
    <main className="message-screen">
      <CircleAlert size={24} />
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

function StagePill({ active, complete, label }: { active: boolean; complete: boolean; label: string }) {
  return <span className={complete ? "stage-pill complete" : active ? "stage-pill active" : "stage-pill"}>{label}</span>;
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

