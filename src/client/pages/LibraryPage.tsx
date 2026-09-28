import { useEffect, useState } from "react";
import {
  Album as AlbumIcon,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Music2,
  Search,
  Trash2,
  UserRound
} from "lucide-react";
import type {
  LibraryAlbumSummary,
  LibraryArtistSummary,
  LibraryTrashResult,
  TrackFile
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState, LibraryArtwork } from "../components/common";
import { albumReleaseLabel, formatBytes, formatDuration, issueLabel, libraryMeta, pluralize, qualitySummary, trackNumberLabel } from "../lib/format";

export const libraryArtistPageSize = 25;
export function LibraryPage({ onChanged }: { onChanged: () => Promise<void> }) {
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
              onClick={() => setArtistPage(1)}
              disabled={artistPage <= 1}
              title="First artists"
            >
              <ChevronsLeft size={18} />
            </button>
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
            <button
              className="icon-button"
              type="button"
              onClick={() => setArtistPage(artistPageCount)}
              disabled={artistPage >= artistPageCount}
              title="Last artists"
            >
              <ChevronsRight size={18} />
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

export async function loadLibraryView(
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

export function LibraryArtistGrid({
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

export function LibraryAlbumGrid({
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

export function LibraryTrackTable({
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

export function filterLibraryTracks(tracks: TrackFile[], search: string) {
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

export function libraryTrashNotice(result: LibraryTrashResult) {
  const errorSuffix = result.errors.length ? ` (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})` : "";
  return `${result.trashed} moved to recycle bin${errorSuffix}.`;
}
