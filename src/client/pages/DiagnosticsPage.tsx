import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  Trash2
} from "lucide-react";
import type {
  OrganizeSpotifyMatchResult,
  TrackFile,
  UnindexedFilesView,
  UnindexedNavidromeCandidate,
  UnindexedNavidromeLookupResult,
  UnindexedTrashResult
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState, StatusPill } from "../components/common";
import { albumReleaseLabel, formatBytes, formatDuration, isTrackKeepManaged, libraryMeta, navidromeMatchMethodLabel, pluralize, qualitySummary, trackNumberLabel } from "../lib/format";
import { libraryTrashNotice } from "./LibraryPage";
import { SpotifyMetadataSearchPanel, SpotifyMetadataToggle, useSpotifyMetadataSearch } from "./OrganizePage";

export type UnindexedFilter = "all" | "possible-stale-scan" | "no-api-match";
export const unindexedPageSize = 150;
export const navicleanIssuesUrl = "https://github.com/thedinz/NaviClean/issues/new";
export const unindexedFilters: Array<{ id: UnindexedFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "possible-stale-scan", label: "Organized" },
  { id: "no-api-match", label: "No match" }
];

export function UnindexedPage({
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

  const spotifyResolved = async (result: OrganizeSpotifyMatchResult) => {
    setNotice(
      `Spotify metadata selected for ${result.matchedTracks} ${pluralize("track", result.matchedTracks)} from ${result.selected.album}. Review the updated target under Organize, then Apply.`
    );
    setError(null);
    await load({ quiet: true });
    await onChanged();
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
          {selectedTracks.length > 0 && (
            <button className="danger-button" type="button" onClick={trashSelected} disabled={Boolean(busy)}>
              {busy === "trash" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>{busy === "trash" ? "Moving" : `Move ${selectedTracks.length} to trash`}</span>
            </button>
          )}
        </div>
      </div>
      {(view?.total ?? 0) > 0 && <div className="notice-bar diagnostics-feedback" role="note">
          <CircleAlert size={18} aria-hidden="true" />
          <span>
            Found a bad match? Report it with the file path, reason, and Navidrome search details.
          </span>
          <a href={navicleanIssuesUrl} target="_blank" rel="noreferrer">
            <span>Open issue</span>
            <ExternalLink size={15} aria-hidden="true" />
          </a>
        </div>}
      {(view?.total ?? 0) > 0 && <div className="organize-preview-tools">
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
          {pageCount > 1 && <div className="pagination-controls" aria-label="Unindexed pages">
            <button
              className="icon-button"
              type="button"
              onClick={() => setPageIndex(0)}
              disabled={currentPage === 0}
              title="First page"
            >
              <ChevronsLeft size={18} />
            </button>
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
            <button
              className="icon-button"
              type="button"
              onClick={() => setPageIndex(pageCount - 1)}
              disabled={currentPage >= pageCount - 1}
              title="Last page"
            >
              <ChevronsRight size={18} />
            </button>
          </div>}
        </div>
      </div>}
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
          onSpotifyResolved={spotifyResolved}
        />
      )}
    </section>
  );
}

export function UnindexedTable({
  allSelected,
  disabled,
  tracks,
  selectedIds,
  onToggle,
  onToggleAll,
  matchBusyId,
  matchResults,
  onCheckNavidrome,
  onSpotifyResolved
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
  onSpotifyResolved: (result: OrganizeSpotifyMatchResult) => void;
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
            <th>Resolve</th>
            <th>Current path</th>
            <th>Quality</th>
            <th>Navidrome</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((track) => (
            <UnindexedTrackRows
              key={track.id}
              disabled={disabled}
              matchBusy={matchBusyId === track.id}
              matchResult={matchResults[track.id]}
              selected={Boolean(selectedIds[track.id])}
              track={track}
              onCheckNavidrome={() => onCheckNavidrome(track)}
              onSpotifyResolved={onSpotifyResolved}
              onToggle={() => onToggle(track)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UnindexedTrackRows({
  disabled,
  matchBusy,
  matchResult,
  selected,
  track,
  onCheckNavidrome,
  onSpotifyResolved,
  onToggle
}: {
  disabled: boolean;
  matchBusy: boolean;
  matchResult?: UnindexedNavidromeLookupResult;
  selected: boolean;
  track: TrackFile;
  onCheckNavidrome: () => void;
  onSpotifyResolved: (result: OrganizeSpotifyMatchResult) => void;
  onToggle: () => void;
}) {
  const spotify = useSpotifyMetadataSearch(track, onSpotifyResolved);

  return (
    <>
      <tr>
        <td>
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggle}
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
          <span>{libraryMeta([track.isrc ? `ISRC ${track.isrc}` : "", isTrackKeepManaged(track.managedBy) ? "TrackKeep" : ""])}</span>
        </td>
        <td>
          <SpotifyMetadataToggle disabled={disabled} spotify={spotify} />
          {spotify.error && !spotify.open && <span className="status-detail spotify-metadata-error">{spotify.error}</span>}
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
            onClick={onCheckNavidrome}
            disabled={disabled || matchBusy}
            title={`Find Navidrome matches for ${track.title}`}
            aria-label={`Find Navidrome matches for ${track.title}`}
          >
            {matchBusy ? <Loader2 className="spin" size={17} /> : <Search size={17} />}
          </button>
        </td>
      </tr>
      {spotify.open && (
        <tr className="unindexed-spotify-row">
          <td colSpan={7}>
            <SpotifyMetadataSearchPanel spotify={spotify} wide />
          </td>
        </tr>
      )}
      {matchResult && (
        <tr className="unindexed-match-row">
          <td colSpan={7}>
            <UnindexedMatchPanel result={matchResult} />
          </td>
        </tr>
      )}
    </>
  );
}

export function UnindexedMatchPanel({ result }: { result: UnindexedNavidromeLookupResult }) {
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

export function UnindexedCandidatePanel({ candidate }: { candidate: UnindexedNavidromeCandidate }) {
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

export function countUnindexedFilters(tracks: TrackFile[]): Record<UnindexedFilter, number> {
  return {
    all: tracks.length,
    "possible-stale-scan": tracks.filter((track) => track.navidromeEnrichment?.code === "possible-stale-scan").length,
    "no-api-match": tracks.filter((track) => track.navidromeEnrichment?.code === "no-api-match").length
  };
}

export function unindexedTrackMatchesFilter(track: TrackFile, filter: UnindexedFilter, search: string) {
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

export function unindexedReasonShortLabel(track: TrackFile) {
  if (track.navidromeEnrichment?.code === "possible-stale-scan") {
    return "Organized local";
  }

  if (track.navidromeEnrichment?.code === "no-api-match") {
    return "No API match";
  }

  return "Unindexed";
}

export function unindexedTrackSummary(track: TrackFile) {
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

export function unindexedCandidateSummary(candidate: UnindexedNavidromeCandidate) {
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

export function navidromePathStatusLabel(candidate: UnindexedNavidromeCandidate) {
  if (candidate.navidrome.pathStatus === "missing") {
    return "No API path";
  }

  if (candidate.navidrome.pathStatus === "outside-library-root") {
    return "Path outside library root";
  }

  return "";
}

export function unindexedCheckLabel(label: string, status: UnindexedNavidromeCandidate["checks"][keyof UnindexedNavidromeCandidate["checks"]]) {
  if (status === "match") {
    return `${label}: match`;
  }

  if (status === "unavailable") {
    return `${label}: unavailable`;
  }

  return `${label}: differs`;
}
