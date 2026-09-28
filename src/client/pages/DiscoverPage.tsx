import { ArrowLeft, Check, Download, Heart, HeartOff, Music2, Search, Settings } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type {
  CatalogArtistSummary,
  CatalogArtistView,
  CatalogReleaseGroup,
  CatalogReleaseView,
  DownloadJob,
  SettingsView,
  SpotifyAlbumDetail,
  SpotifyArtistDiscography,
  SpotifyArtistSummary
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState } from "../components/common";
import { Artwork, Badge, RightsConfirmation, Spinner, Tabs } from "../components/ui";
import { useLiveEvent } from "../lib/events";
import { formatDuration, plural } from "../lib/format";
import { navigate, routeHref, type Route } from "../lib/router";

type CatalogMode = "musicbrainz" | "spotify";
type GroupFilter = "albums" | "eps" | "singles" | "other" | "all";

export function DiscoverPage({ route, onOpenSettings }: { route: Route; onOpenSettings: () => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const params = route.params;
  const spotifyReady = Boolean(settings?.catalog.spotify.enabled && settings.catalog.spotify.clientId && settings.catalog.spotify.clientSecretSet);
  const mode: CatalogMode = params.get("catalog") === "spotify" && spotifyReady ? "spotify" : "musicbrainz";

  useEffect(() => {
    api<SettingsView>("/settings").then(setSettings).catch(() => undefined);
  }, []);

  return (
    <div className="page-stack discover">
      {spotifyReady && (
        <Tabs<CatalogMode>
          label="Catalog"
          value={mode}
          onChange={(next) => navigate("discover", { catalog: next === "spotify" ? "spotify" : null })}
          tabs={[
            { id: "musicbrainz", label: "MusicBrainz" },
            { id: "spotify", label: "Spotify" }
          ]}
        />
      )}
      {mode === "musicbrainz" ? (
        params.get("rg") ? (
          <ReleaseView releaseGroupId={params.get("rg")!} releaseId={params.get("release")} artistId={params.get("artist")} />
        ) : params.get("artist") ? (
          <ArtistView artistId={params.get("artist")!} />
        ) : (
          <ArtistSearch query={params.get("q") ?? ""} />
        )
      ) : (
        <SpotifyDiscover route={route} onOpenSettings={onOpenSettings} />
      )}
    </div>
  );
}

function ArtistSearch({ query: initialQuery }: { query: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [artists, setArtists] = useState<CatalogArtistSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initialQuery.trim()) {
      setArtists(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    api<{ artists: CatalogArtistSummary[] }>(`/catalog/artists?query=${encodeURIComponent(initialQuery)}`)
      .then((body) => !cancelled && setArtists(body.artists))
      .catch((caught) => !cancelled && setError((caught as Error).message))
      .finally(() => !cancelled && setBusy(false));
    return () => {
      cancelled = true;
    };
  }, [initialQuery]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    navigate("discover", { q: query.trim() || null });
  };

  return (
    <>
      <form className="search-hero" onSubmit={submit}>
        <label className="search-box large">
          <Search size={20} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search artists on MusicBrainz" autoFocus />
        </label>
        <button className="primary-button" type="submit" disabled={!query.trim() || busy}>
          {busy ? <Spinner size={18} /> : <Search size={18} />}
          <span>Search</span>
        </button>
      </form>
      <p className="supporting-note">
        MusicBrainz supplies the catalog, so downloads arrive with the same release IDs NaviClean uses to organize your library. Only download music you are authorized to access.
      </p>
      {busy && <ActionProgress label="Searching MusicBrainz" />}
      {error && <div className="error-list"><span>{error}</span></div>}
      {artists && artists.length === 0 && !busy && <EmptyState icon={Music2} title="No artists found" description="Try a different spelling or fewer words." />}
      {artists && artists.length > 0 && (
        <div className="card-grid artists">
          {artists.map((artist) => (
            <a className="media-card" key={artist.id} href={routeHref("discover", { artist: artist.id })}>
              <Artwork src={null} label={artist.name} kind="artist" size="fill" />
              <span className="media-card-body">
                <strong>{artist.name}</strong>
                <span>{[artist.type, artist.country, artist.lifeSpan].filter(Boolean).join(" · ") || "Artist"}</span>
                {artist.disambiguation && <span className="muted">{artist.disambiguation}</span>}
                {artist.localTrackCount > 0 && <Badge tone="success">{plural(artist.localTrackCount, "track")} in library</Badge>}
              </span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function ArtistView({ artistId }: { artistId: string }) {
  const [view, setView] = useState<CatalogArtistView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GroupFilter>("albums");
  const [followBusy, setFollowBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setError(null);
    api<CatalogArtistView>(`/catalog/artists/${encodeURIComponent(artistId)}`)
      .then((body) => {
        if (cancelled) return;
        setView(body);
        const counts = groupCounts(body.releaseGroups);
        setFilter(counts.albums > 0 ? "albums" : counts.eps > 0 ? "eps" : counts.singles > 0 ? "singles" : "all");
      })
      .catch((caught) => !cancelled && setError((caught as Error).message));
    return () => {
      cancelled = true;
    };
  }, [artistId]);

  const groups = useMemo(() => (view ? view.releaseGroups.filter((group) => matchesFilter(group, filter)) : []), [view, filter]);
  const counts = view ? groupCounts(view.releaseGroups) : null;

  const toggleFollow = async () => {
    if (!view) return;
    setFollowBusy(true);
    try {
      if (view.followed) {
        await api(`/follows/${encodeURIComponent(view.artist.id)}`, { method: "DELETE" });
      } else {
        await api("/follows", {
          method: "POST",
          body: JSON.stringify({ artistId: view.artist.id, name: view.artist.name, disambiguation: view.artist.disambiguation })
        });
      }
      setView({ ...view, followed: !view.followed });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setFollowBusy(false);
    }
  };

  if (error) {
    return <div className="error-list"><span>{error}</span></div>;
  }
  if (!view) {
    return <ActionProgress label="Loading discography from MusicBrainz" />;
  }

  return (
    <>
      <a className="back-link" href={routeHref("discover")}>
        <ArrowLeft size={16} /> Search
      </a>
      <header className="entity-header">
        <Artwork src={null} label={view.artist.name} kind="artist" size="lg" />
        <div className="entity-header-copy">
          <span className="eyebrow">{[view.artist.type || "Artist", view.artist.country, view.artist.lifeSpan].filter(Boolean).join(" · ")}</span>
          <h2>{view.artist.name}</h2>
          {view.artist.disambiguation && <p className="muted">{view.artist.disambiguation}</p>}
          <div className="chip-row">
            {view.artist.genres.map((genre) => <Badge key={genre}>{genre}</Badge>)}
            {view.artist.localTrackCount > 0 && <Badge tone="success">{plural(view.artist.localTrackCount, "track")} in your library</Badge>}
          </div>
        </div>
        <div className="entity-header-actions">
          <button className={view.followed ? "secondary-button" : "primary-button"} type="button" onClick={toggleFollow} disabled={followBusy}>
            {followBusy ? <Spinner size={18} /> : view.followed ? <HeartOff size={18} /> : <Heart size={18} />}
            <span>{view.followed ? "Unfollow" : "Follow"}</span>
          </button>
          <a className="secondary-button" href={`https://musicbrainz.org/artist/${view.artist.id}`} target="_blank" rel="noreferrer">
            MusicBrainz
          </a>
        </div>
      </header>

      {counts && (
        <Tabs<GroupFilter>
          label="Release types"
          value={filter}
          onChange={setFilter}
          tabs={[
            { id: "albums", label: "Albums", count: counts.albums },
            { id: "eps", label: "EPs", count: counts.eps },
            { id: "singles", label: "Singles", count: counts.singles },
            { id: "other", label: "Live, compilations & more", count: counts.other },
            { id: "all", label: "All", count: view.releaseGroups.length }
          ]}
        />
      )}

      {groups.length === 0 ? (
        <EmptyState icon={Music2} title="Nothing in this category" />
      ) : (
        <div className="card-grid albums">
          {groups.map((group) => (
            <a className="media-card" key={group.id} href={routeHref("discover", { artist: artistId, rg: group.id })}>
              <Artwork src={group.coverUrl} label={group.title} size="fill" />
              <span className="media-card-body">
                <strong>{group.title}</strong>
                <span>{[group.year, [group.primaryType, ...group.secondaryTypes].join(" + ")].filter(Boolean).join(" · ")}</span>
                {group.localTrackCount > 0 && <Badge tone="success">{plural(group.localTrackCount, "track")} in library</Badge>}
              </span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function ReleaseView({ releaseGroupId, releaseId, artistId }: { releaseGroupId: string; releaseId: string | null; artistId: string | null }) {
  const [view, setView] = useState<CatalogReleaseView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queuedJob, setQueuedJob] = useState<DownloadJob | null>(null);

  const load = async () => {
    const query = releaseId ? `?release=${encodeURIComponent(releaseId)}` : "";
    const next = await api<CatalogReleaseView>(`/catalog/release-groups/${encodeURIComponent(releaseGroupId)}${query}`);
    setView(next);
    setSelected(Object.fromEntries(next.tracks.filter((track) => !track.present && !track.queued).map((track) => [track.id, true])));
  };

  useEffect(() => {
    setView(null);
    setError(null);
    setQueuedJob(null);
    load().catch((caught) => setError((caught as Error).message));
  }, [releaseGroupId, releaseId]);

  useLiveEvent((event) => {
    if (event.type === "catalog-changed" && view) {
      void load().catch(() => undefined);
    }
  });

  if (error) {
    return <div className="error-list"><span>{error}</span></div>;
  }
  if (!view) {
    return <ActionProgress label="Loading release from MusicBrainz" />;
  }

  const selectable = view.tracks.filter((track) => !track.present);
  const selectedIds = selectable.filter((track) => selected[track.id]).map((track) => track.id);
  const allSelected = selectable.length > 0 && selectedIds.length === selectable.length;
  const multiDisc = new Set(view.tracks.map((track) => track.discNumber)).size > 1;

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { job } = await api<{ job: DownloadJob }>("/downloads", {
        method: "POST",
        body: JSON.stringify({ catalog: "musicbrainz", releaseId: view.release.id, trackIds: selectedIds, rightsConfirmed })
      });
      setQueuedJob(job);
      setRightsConfirmed(false);
      await load();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <a className="back-link" href={routeHref("discover", { artist: artistId ?? view.release.artistIds[0] })}>
        <ArrowLeft size={16} /> {view.release.artist || "Artist"}
      </a>
      <header className="entity-header release">
        <Artwork src={view.release.coverUrl} label={view.release.title} size="lg" />
        <div className="entity-header-copy">
          <span className="eyebrow">{[view.releaseGroup.primaryType, ...view.releaseGroup.secondaryTypes].join(" + ")}</span>
          <h2>{view.release.title}</h2>
          <p>{view.release.artist}</p>
          <div className="chip-row">
            {view.release.date && <Badge>{view.release.date}</Badge>}
            {view.release.labels[0] && <Badge>{view.release.labels[0]}</Badge>}
            <Badge>{plural(view.tracks.length, "track")}</Badge>
            <Badge tone={view.localTrackCount === view.tracks.length ? "success" : view.localTrackCount > 0 ? "warning" : "neutral"}>
              {view.localTrackCount}/{view.tracks.length} in library
            </Badge>
          </div>
        </div>
        <label className="edition-select">
          Edition
          <select
            value={view.release.id}
            onChange={(event) => navigate("discover", { artist: artistId, rg: releaseGroupId, release: event.target.value })}
          >
            {view.editions.map((edition) => (
              <option key={edition.id} value={edition.id}>
                {[edition.date || "Undated", edition.country, edition.formats.join("+"), `${edition.trackCount} tracks`, edition.disambiguation, edition.status !== "Official" ? edition.status : ""]
                  .filter(Boolean)
                  .join(" · ")}
                {edition.id === view.preferredReleaseId ? " (recommended)" : ""}
              </option>
            ))}
          </select>
        </label>
      </header>

      {queuedJob && (
        <div className="notice-bar success">
          <span>
            Queued {plural(queuedJob.counts.pending, "track")}{queuedJob.counts.skipped ? `; ${queuedJob.counts.skipped} already in your library or queue` : ""}.
          </span>
          <a className="text-link" href={routeHref("downloads", { job: queuedJob.id })}>Follow progress</a>
        </div>
      )}

      <section className="panel">
        <div className="toolbar">
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={selectable.length === 0}
              onChange={(event) =>
                setSelected(event.target.checked ? Object.fromEntries(selectable.map((track) => [track.id, true])) : {})
              }
            />
            <span>{selectedIds.length > 0 ? `${selectedIds.length} selected` : "Select missing tracks"}</span>
          </label>
          <span className="muted">Tracks already in your library are skipped automatically.</span>
        </div>
        <div className="table-wrap">
          <table className="tracklist">
            <thead>
              <tr>
                <th aria-label="Select" />
                <th>#</th>
                <th>Title</th>
                <th>Status</th>
                <th className="numeric">Length</th>
              </tr>
            </thead>
            <tbody>
              {view.tracks.map((track) => (
                <tr key={track.id} className={track.present ? "is-present" : ""}>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(selected[track.id])}
                      disabled={track.present}
                      aria-label={`Select ${track.title}`}
                      onChange={(event) => setSelected((current) => ({ ...current, [track.id]: event.target.checked }))}
                    />
                  </td>
                  <td className="track-number">{multiDisc ? `${track.discNumber}-` : ""}{track.trackNumber}</td>
                  <td>
                    <strong>{track.title}</strong>
                    {track.artists.join(", ") !== view.release.artist && <span>{track.artists.join(", ")}</span>}
                  </td>
                  <td>
                    {track.present ? (
                      <Badge tone="success"><Check size={12} /> In library</Badge>
                    ) : track.queued ? (
                      <Badge tone="accent">Queued</Badge>
                    ) : (
                      <Badge>Missing</Badge>
                    )}
                  </td>
                  <td className="numeric">{track.duration ? formatDuration(track.duration) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="download-bar">
          <RightsConfirmation checked={rightsConfirmed} onChange={setRightsConfirmed} disabled={busy} />
          <button className="primary-button" type="button" onClick={download} disabled={busy || !rightsConfirmed || selectedIds.length === 0}>
            {busy ? <Spinner size={18} /> : <Download size={18} />}
            <span>{selectedIds.length > 0 ? `Download ${plural(selectedIds.length, "track")}` : "Download"}</span>
          </button>
        </div>
      </section>
    </>
  );
}

function SpotifyDiscover({ route, onOpenSettings }: { route: Route; onOpenSettings: () => void }) {
  const [query, setQuery] = useState(route.params.get("q") ?? "");
  const [artists, setArtists] = useState<SpotifyArtistSummary[]>([]);
  const [discography, setDiscography] = useState<SpotifyArtistDiscography | null>(null);
  const [album, setAlbum] = useState<SpotifyAlbumDetail | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queuedJob, setQueuedJob] = useState<DownloadJob | null>(null);

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const search = (event: FormEvent) => {
    event.preventDefault();
    void run("search", async () => {
      const body = await api<{ artists: SpotifyArtistSummary[] }>(`/spotify/artists/search?query=${encodeURIComponent(query.trim())}`);
      setArtists(body.artists);
      setDiscography(null);
      setAlbum(null);
    });
  };

  const openArtist = (artist: SpotifyArtistSummary) =>
    run(`artist:${artist.id}`, async () => {
      setDiscography(await api<SpotifyArtistDiscography>(`/spotify/artists/${artist.id}/discography`));
      setAlbum(null);
    });

  const openAlbum = (albumId: string) =>
    run(`album:${albumId}`, async () => {
      const body = await api<{ album: SpotifyAlbumDetail }>(`/spotify/albums/${albumId}`);
      setAlbum(body.album);
      setQueuedJob(null);
      setSelected(Object.fromEntries(body.album.tracks.filter((track) => !track.present).map((track) => [track.id, true])));
    });

  const selectedIds = album?.tracks.filter((track) => !track.present && selected[track.id]).map((track) => track.id) ?? [];

  const download = () =>
    run("download", async () => {
      if (!album) return;
      const { job } = await api<{ job: DownloadJob }>("/downloads", {
        method: "POST",
        body: JSON.stringify({ catalog: "spotify", albumId: album.id, trackIds: selectedIds, rightsConfirmed })
      });
      setQueuedJob(job);
      setRightsConfirmed(false);
    });

  return (
    <>
      <form className="search-hero" onSubmit={search}>
        <label className="search-box large">
          <Search size={20} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Spotify artists" />
        </label>
        <button className="primary-button" type="submit" disabled={!query.trim() || busy === "search"}>
          {busy === "search" ? <Spinner size={18} /> : <Search size={18} />}
          <span>Search</span>
        </button>
        <button className="secondary-button" type="button" onClick={onOpenSettings}>
          <Settings size={18} />
          <span>Spotify settings</span>
        </button>
      </form>
      <p className="supporting-note">Spotify supplies metadata and artwork only; downloads are tagged with TrackKeep identity tags.</p>
      {busy && busy !== "search" && <ActionProgress label="Loading from Spotify" />}
      {error && <div className="error-list"><span>{error}</span></div>}

      {!discography && artists.length > 0 && (
        <div className="card-grid artists">
          {artists.map((artist) => (
            <button className="media-card" type="button" key={artist.id} onClick={() => void openArtist(artist)}>
              <Artwork src={artist.imageUrl} label={artist.name} kind="artist" size="fill" />
              <span className="media-card-body"><strong>{artist.name}</strong><span>View discography</span></span>
            </button>
          ))}
        </div>
      )}

      {discography && !album && (
        <>
          <button className="back-link" type="button" onClick={() => setDiscography(null)}><ArrowLeft size={16} /> Artists</button>
          <h2 className="section-title">{discography.artist.name}</h2>
          <div className="card-grid albums">
            {discography.albums.map((candidate) => (
              <button className="media-card" type="button" key={candidate.id} onClick={() => void openAlbum(candidate.id)}>
                <Artwork src={candidate.imageUrl} label={candidate.name} size="fill" />
                <span className="media-card-body">
                  <strong>{candidate.name}</strong>
                  <span>{candidate.releaseYear ?? "Unknown year"} · {candidate.localTrackCount}/{candidate.totalTracks} local</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {album && (
        <>
          <button className="back-link" type="button" onClick={() => setAlbum(null)}><ArrowLeft size={16} /> {album.artist.name}</button>
          <header className="entity-header release">
            <Artwork src={album.imageUrl} label={album.name} size="lg" />
            <div className="entity-header-copy">
              <span className="eyebrow">{album.albumType}</span>
              <h2>{album.name}</h2>
              <p>{album.artist.name} · {album.releaseYear}</p>
              <Badge>{album.localTrackCount}/{album.tracks.length} in library</Badge>
            </div>
          </header>
          {queuedJob && (
            <div className="notice-bar success">
              <span>Queued {plural(queuedJob.counts.pending, "track")}.</span>
              <a className="text-link" href={routeHref("downloads", { job: queuedJob.id })}>Follow progress</a>
            </div>
          )}
          <section className="panel">
            <div className="table-wrap">
              <table className="tracklist">
                <thead>
                  <tr><th aria-label="Select" /><th>#</th><th>Title</th><th>Status</th><th className="numeric">Length</th></tr>
                </thead>
                <tbody>
                  {album.tracks.map((track) => (
                    <tr key={track.id} className={track.present ? "is-present" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          checked={Boolean(selected[track.id])}
                          disabled={track.present}
                          onChange={(event) => setSelected((current) => ({ ...current, [track.id]: event.target.checked }))}
                        />
                      </td>
                      <td className="track-number">{track.discNumber}-{track.trackNumber}</td>
                      <td><strong>{track.name}</strong><span>{track.artists.join(", ")}</span></td>
                      <td>{track.present ? <Badge tone="success">In library</Badge> : <Badge>Missing</Badge>}</td>
                      <td className="numeric">{formatDuration(track.duration)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="download-bar">
              <RightsConfirmation checked={rightsConfirmed} onChange={setRightsConfirmed} disabled={busy === "download"} />
              <button className="primary-button" type="button" onClick={() => void download()} disabled={!rightsConfirmed || selectedIds.length === 0 || busy === "download"}>
                {busy === "download" ? <Spinner size={18} /> : <Download size={18} />}
                <span>Download {plural(selectedIds.length, "track")}</span>
              </button>
            </div>
          </section>
        </>
      )}
    </>
  );
}

function groupCounts(groups: CatalogReleaseGroup[]) {
  return {
    albums: groups.filter((group) => matchesFilter(group, "albums")).length,
    eps: groups.filter((group) => matchesFilter(group, "eps")).length,
    singles: groups.filter((group) => matchesFilter(group, "singles")).length,
    other: groups.filter((group) => matchesFilter(group, "other")).length
  };
}

function matchesFilter(group: CatalogReleaseGroup, filter: GroupFilter) {
  const studio = group.secondaryTypes.length === 0;
  switch (filter) {
    case "albums":
      return studio && group.primaryType === "Album";
    case "eps":
      return studio && group.primaryType === "EP";
    case "singles":
      return studio && group.primaryType === "Single";
    case "other":
      return !studio || !["Album", "EP", "Single"].includes(group.primaryType);
    default:
      return true;
  }
}
