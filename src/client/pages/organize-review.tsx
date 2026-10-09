import { useState } from "react";
import { CircleCheck, CircleHelp, CircleX, History, Loader2, Undo2 } from "lucide-react";
import type {
  OrganizeChangeField,
  OrganizeChangeKind,
  OrganizeCrossCheck,
  OrganizePlan,
  OrganizeRunSummary
} from "../../shared/types";

type PlanItem = OrganizePlan["items"][number];

export type OrganizeChangeFilter = "all" | Exclude<OrganizeChangeKind, "none"> | "spotify-differs";

/** Least risky first, so the safe buckets are the first ones a reviewer sees. */
export const organizeChangeFilters: Array<{ id: OrganizeChangeFilter; label: string; hint: string }> = [
  { id: "all", label: "All changes", hint: "Every item in the selected status" },
  { id: "cosmetic", label: "Formatting only", hint: "Only case, punctuation, spacing or accents change" },
  { id: "track-number", label: "Track number", hint: "The track or disc number changes; names stay the same" },
  { id: "year", label: "Year", hint: "Only the year in the folder name changes" },
  { id: "layout", label: "Into standard layout", hint: "The file is not in Artist/Album (Year)/ yet; names come from its metadata" },
  { id: "identity", label: "Artist / album / title", hint: "A name really changes. Review these one by one" },
  { id: "spotify-differs", label: "Spotify disagrees", hint: "Cross-checked, and Spotify's closest release differs" }
];

const fieldLabels: Record<OrganizeChangeField, string> = {
  albumArtist: "Artist",
  album: "Album",
  year: "Year",
  track: "Track",
  title: "Title"
};

export function organizeItemMatchesChangeFilter(item: PlanItem, filter: OrganizeChangeFilter) {
  if (filter === "all") {
    return true;
  }
  if (filter === "spotify-differs") {
    return item.crossCheck?.status === "differs";
  }
  return item.changeKind === filter;
}

export function countOrganizeChangeFilters(items: PlanItem[]) {
  const counts = Object.fromEntries(organizeChangeFilters.map((filter) => [filter.id, 0])) as Record<OrganizeChangeFilter, number>;
  for (const item of items) {
    for (const filter of organizeChangeFilters) {
      if (organizeItemMatchesChangeFilter(item, filter.id)) {
        counts[filter.id] += 1;
      }
    }
  }
  return counts;
}

/** Case-insensitive match on artist, album, title or either path, for applying one artist or album at a time. */
export function organizeItemMatchesText(item: PlanItem, text: string) {
  const needle = text.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return [item.albumArtist, item.artist, item.album, item.title, item.sourceRelativePath, item.targetRelativePath]
    .some((value) => (value || "").toLowerCase().includes(needle));
}

export function changeKindLabel(kind: OrganizeChangeKind | undefined) {
  return organizeChangeFilters.find((filter) => filter.id === kind)?.label ?? "";
}

export function ChangeFilterBar({
  counts,
  value,
  text,
  onChange,
  onTextChange
}: {
  counts: Record<OrganizeChangeFilter, number>;
  value: OrganizeChangeFilter;
  text: string;
  onChange: (value: OrganizeChangeFilter) => void;
  onTextChange: (value: string) => void;
}) {
  return (
    <div className="change-filter-row">
      <div className="change-filter" role="radiogroup" aria-label="Kind of change">
        {organizeChangeFilters
          .filter((filter) => filter.id === "all" || filter.id === value || counts[filter.id] > 0)
          .map((filter) => (
            <button
              key={filter.id}
              type="button"
              role="radio"
              aria-checked={value === filter.id}
              className={`change-chip change-chip-${filter.id}${value === filter.id ? " active" : ""}`}
              title={filter.hint}
              onClick={() => onChange(filter.id)}
            >
              <span>{filter.label}</span>
              <strong>{counts[filter.id].toLocaleString()}</strong>
            </button>
          ))}
      </div>
      <input
        className="change-filter-text"
        type="search"
        value={text}
        placeholder="Filter by artist, album or title"
        aria-label="Filter by artist, album or title"
        onChange={(event) => onTextChange(event.target.value)}
      />
    </div>
  );
}

/** What changes in this move, field by field, and where each new value came from. */
export function ChangeDetails({ item }: { item: PlanItem }) {
  const changes = item.changes ?? [];

  if (item.changeKind === "layout") {
    const source = changes[0]?.source;
    return (
      <div className="change-details">
        <span className="change-line">
          Not in the standard layout yet. Names come from {source ?? "this file's metadata"}.
        </span>
      </div>
    );
  }

  if (changes.length === 0) {
    return null;
  }

  return (
    <div className="change-details">
      {changes.map((change) => (
        <span className="change-line" key={change.field}>
          <strong>{fieldLabels[change.field]}</strong>{" "}
          <span className="change-from">{change.from}</span> → <span className="change-to">{change.to}</span>
          {change.cosmetic ? <em> · formatting only</em> : <em> · from {change.source}</em>}
        </span>
      ))}
    </div>
  );
}

export function CrossCheckBadge({ check }: { check?: OrganizeCrossCheck }) {
  if (!check) {
    return null;
  }

  if (check.status === "agrees") {
    return (
      <span className="crosscheck crosscheck-agrees" title={check.spotify ? `${check.spotify.album} (${check.spotify.year ?? "?"})` : undefined}>
        <CircleCheck size={15} /> {check.message}
      </span>
    );
  }

  if (check.status === "differs") {
    return (
      <span className="crosscheck crosscheck-differs">
        <CircleX size={15} /> {check.message}{" "}
        {check.differences.map((difference) => (
          <span key={difference.field} className="crosscheck-difference">
            {fieldLabels[difference.field]}: Spotify has “{difference.spotify}”
          </span>
        ))}
        {check.spotify?.url && (
          <a href={check.spotify.url} target="_blank" rel="noreferrer">Open on Spotify</a>
        )}
      </span>
    );
  }

  return (
    <span className="crosscheck crosscheck-unknown">
      <CircleHelp size={15} /> {check.message}
    </span>
  );
}

export function OrganizeHistory({
  runs,
  disabled,
  onUndo
}: {
  runs: OrganizeRunSummary[];
  disabled: boolean;
  onUndo: (run: OrganizeRunSummary) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  if (runs.length === 0) {
    return null;
  }

  return (
    <details className="organizer-notes organize-history">
      <summary>
        <History size={15} /> Organize history · {runs.filter((run) => run.undoable > 0).length} undoable
      </summary>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>
            <div>
              <strong>{run.label}</strong>
              <small>
                {new Date(run.createdAt).toLocaleString()} · {run.moved.toLocaleString()} moved
                {run.undoneAt ? " · undone" : run.undoable < run.moved ? ` · ${run.moved - run.undoable} already undone` : ""}
              </small>
            </div>
            {run.undoable > 0 && (
              <button
                className="secondary-button compact-button"
                type="button"
                disabled={disabled || Boolean(busyId)}
                onClick={async () => {
                  setBusyId(run.id);
                  try {
                    await onUndo(run);
                  } finally {
                    setBusyId(null);
                  }
                }}
              >
                {busyId === run.id ? <Loader2 className="spin" size={16} /> : <Undo2 size={16} />}
                <span>{busyId === run.id ? "Undoing" : `Undo ${run.undoable.toLocaleString()}`}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
