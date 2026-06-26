import {
  Activity,
  Album as AlbumIcon,
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
  Music2,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Trash2,
  UserRound
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthInfo,
  DuplicateBulkResolveResult,
  DuplicateGroup,
  LibraryAlbumSummary,
  LibraryArtistSummary,
  LibraryStats,
  LibraryTrashResult,
  NamingMode,
  OrganizeApplyResult,
  OrganizeCollisionCandidate,
  OrganizePlan,
  OrganizeTrashResult,
  OrganizeTrashSelection,
  RecycleBinDeleteResult,
  RecycleBinItem,
  RecycleBinView,
  ScanStatus,
  SettingsView,
  SpotifyAlbumDetail,
  SpotifyArtistDiscography,
  SpotifyArtistSummary,
  SpotifyCatalogDownloadJob,
  SpotifyCatalogDownloadPreviewResult,
  TrackFile
} from "../shared/types";
import { api } from "./api";
import { appVersion } from "./version";

type Page = "dashboard" | "library" | "discover" | "duplicates" | "organize" | "trash" | "settings";
type OrganizePreviewFilter = "attention" | "ready" | "duplicate-target" | "conflict" | "missing" | "same" | "all";
type OrganizePreviewItem = OrganizePlan["items"][number];

const libraryArtistPageSize = 25;
const organizePreviewPageSize = 150;

const navItems: Array<{ id: Page; label: string; icon: typeof Gauge }> = [
  { id: "dashboard", label: "Dashboard", icon: Gauge },
  { id: "library", label: "Library", icon: Database },
  { id: "discover", label: "Discover", icon: Music2 },
  { id: "organize", label: "Organize", icon: FolderInput },
  { id: "duplicates", label: "Duplicates", icon: CopyX },
  { id: "trash", label: "Trash", icon: Trash2 },
  { id: "settings", label: "Settings", icon: Settings }
];

const namingModes: Array<{ id: NamingMode; label: string }> = [
  { id: "standard", label: "Standard" },
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

const standardNamingDefaults = {
  artistFolderFormat: "{Album Artist Name}",
  standardTrackFormat:
    "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {track:00} - {Track Title}",
  multiDiscTrackFormat:
    "{Album Artist Name} - {Album Title} ({Release Year})/{Album Artist Name} - {Album Title} ({Release Year}) - {medium:00}-{track:00} - {Track Title}",
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
        {page === "library" && <LibraryPage onChanged={refreshStats} />}
        {page === "discover" && <DiscoverPage />}
        {page === "duplicates" && (
          <DuplicatesPage stats={stats} onChanged={refreshStats} onOpenOrganize={() => setPage("organize")} />
        )}
        {page === "organize" && <OrganizePage onChanged={refreshStats} />}
        {page === "trash" && <TrashPage />}
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
  const selectedRemoveIds = useMemo(
    () => Object.entries(selectedTrashIds).filter(([, selected]) => selected).map(([id]) => id),
    [selectedTrashIds]
  );

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
      {!loading && groups.length === 0 && <EmptyState icon={Check} title="No duplicate groups" />}
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
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"selected" | "empty" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const items = view?.items || [];
  const selectedItems = items.filter((item) => selectedIds[item.id]);
  const allSelected = items.length > 0 && selectedItems.length === items.length;

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

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds({});
      return;
    }

    setSelectedIds(Object.fromEntries(items.map((item) => [item.id, true])));
  };

  const toggleItem = (item: RecycleBinItem) => {
    setSelectedIds((current) => ({
      ...current,
      [item.id]: !current[item.id]
    }));
  };

  const deleteSelected = async () => {
    if (selectedItems.length === 0) {
      return;
    }

    if (!window.confirm(`Permanently delete ${selectedItems.length} selected file(s) from Trash?`)) {
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

    if (!window.confirm(`Permanently delete all ${view.totalFiles} file(s) from Trash?`)) {
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
          <span>{view?.totalFiles || 0} files</span>
          <span>{formatBytes(view?.totalSize || 0)}</span>
          <span>{selectedItems.length} selected</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || Boolean(busy)}>
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{loading ? "Loading" : "Refresh"}</span>
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
      {(loading || busy) && <ActionProgress label={busy ? "Deleting recycle bin files" : "Loading recycle bin"} />}
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
              {items.map((item) => (
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
                    <span>{item.extension.replace(".", "").toUpperCase() || "File"}</span>
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

function OrganizePage({ onChanged }: { onChanged: () => Promise<void> }) {
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
  const organizeItems = plan?.items || [];
  const filterCounts = useMemo(() => countOrganizePreviewFilters(organizeItems), [organizeItems]);
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

  const load = async ({ clearNotice = true }: { clearNotice?: boolean } = {}) => {
    const requestId = previewRequestId.current + 1;
    previewRequestId.current = requestId;
    setPreviewBusy(true);
    if (clearNotice) {
      setNotice(null);
      setApplyErrors([]);
    }

    try {
      const nextPlan = await api<OrganizePlan>("/organize/preview", { method: "POST" });
      if (requestId === previewRequestId.current) {
        showPlan(nextPlan);
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
    void load();
  }, []);

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

      if (result.plan) {
        showPlan(result.plan);
      }

      await load({ clearNotice: false });
      await onChanged();
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
      setSelectedTrashCandidates({});
      showPlan(result.plan);
      await load({ clearNotice: false });
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
        <span>Files move into the active album layout before duplicate cleanup unlocks.</span>
      </div>
      <div className="toolbar">
        <div className="summary-chips">
          <span>{plan?.summary.ready || 0} ready</span>
          <span>{plan?.summary.same || 0} organized</span>
          <span>{plan?.summary.duplicateTargets || 0} duplicates</span>
          <span>{plan?.summary.conflicts || 0} conflicts</span>
          <span>{plan?.summary.missing || 0} missing</span>
          <span>{selectedTrashSelections.length} selected</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={previewBusy || applyBusy || Boolean(trashBusyKey)}>
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
                          <>
                            <PathDiff value={item.targetRelativePath} compareTo={item.sourceRelativePath} />
                            {item.targetSource === "spotify" && <span className="status-detail">Spotify metadata</span>}
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
    if (!album) {
      return;
    }

    setBusy("download-preview");
    setNotice(null);
    setDownloadJob(null);

    try {
      const result = await api<{ preview: SpotifyCatalogDownloadPreviewResult }>("/spotify/download-preview", {
        method: "POST",
        body: JSON.stringify({
          spotifyAlbumId: album.id,
          trackIds: selectedMissingTrackIds
        })
      });

      setDownloadPreview(result.preview);
      setNotice(
        `Found provider candidates for ${result.preview.downloadableCount} of ${result.preview.items.length} selected track${result.preview.items.length === 1 ? "" : "s"}.`
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
              <span>{busy === "download-preview" ? "Finding" : "Find sources"}</span>
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
                {downloadPreview.downloadableCount}/{downloadPreview.items.length} ready
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

function SettingsPage({ onAuthChange }: { onAuthChange: (auth: AuthInfo) => void }) {
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
            mode: settings.naming.mode,
            libraryPath: settings.naming.libraryPath,
            recycleBinPath: settings.naming.recycleBinPath,
            artistFolderFormat: settings.naming.artistFolderFormat,
            standardTrackFormat: settings.naming.standardTrackFormat,
            multiDiscTrackFormat: settings.naming.multiDiscTrackFormat,
            replaceIllegalCharacters: settings.naming.replaceIllegalCharacters,
            colonReplacementFormat: settings.naming.colonReplacementFormat
          }
        })
      });

      setSettings(next);
      setAdminPassword("");
      setNavidromePassword("");
      setSpotifyClientSecret("");
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

  const updateNaming = (update: Partial<SettingsView["naming"]>) => {
    if (!settings) {
      return;
    }
    setSettings({ ...settings, naming: { ...settings.naming, ...update } });
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
          <span className="subsection-label">Naming mode</span>
          <div className="segmented-control" role="radiogroup" aria-label="Naming mode">
            {namingModes.map((mode) => (
              <button
                key={mode.id}
                className={settings.naming.mode === mode.id ? "active" : ""}
                type="button"
                role="radio"
                aria-checked={settings.naming.mode === mode.id}
                onClick={() =>
                  updateNaming(
                    mode.id === "standard"
                      ? { mode: mode.id, ...standardNamingDefaults }
                      : { mode: mode.id }
                  )
                }
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        {settings.naming.mode === "standard" && (
          <div className="notice-bar safety">
            <strong>Standard naming</strong>
            <span>Uses Artist / Artist - Album (Year) / Artist - Album (Year) - 01 - Track Title.</span>
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

function libraryTrashNotice(result: LibraryTrashResult) {
  const errorSuffix = result.errors.length ? ` (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})` : "";
  return `${result.trashed} moved to recycle bin${errorSuffix}.`;
}

function libraryMeta(values: string[]) {
  return values.filter(Boolean).join(" / ");
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

function isCatalogDownloadJobActive(job: SpotifyCatalogDownloadJob | null) {
  return job?.status === "queued" || job?.status === "running";
}

function isCatalogDownloadJobTerminal(job: SpotifyCatalogDownloadJob) {
  return job.status === "completed" || job.status === "failed";
}
