import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  CircleAlert,
  Fingerprint,
  FolderInput,
  FolderX,
  Loader2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2
} from "lucide-react";
import type {
  LibraryStats,
  OrganizeApplyResult,
  OrganizeCrossCheckResult,
  OrganizeRunSummary,
  OrganizeUndoResult,
  OrganizeIdentificationMatchResult,
  OrganizeCollisionCandidate,
  OrganizePlan,
  OrganizeSkipResult,
  OrganizeSpotifyMatchResult,
  OrganizeTrustPathResult,
  OrganizeTrashResult,
  OrganizeTrashSelection,
  SpotifyMetadataMatch,
  SpotifyMetadataSearchResult,
  TrackFile
} from "../../shared/types";
import { api, ApiError } from "../api";
import { ActionProgress, EmptyState, PathDiff, StatusPill } from "../components/common";
import { collisionRoleLabel, isTrackKeepManaged, navidromeMatchMethodLabel, pathDirectory, pathFilename, pluralize, qualitySummary } from "../lib/format";
import {
  ChangeDetails,
  ChangeFilterBar,
  changeKindLabel,
  countOrganizeChangeFilters,
  CrossCheckBadge,
  OrganizeHistory,
  organizeChangeFilters,
  organizeItemMatchesChangeFilter,
  organizeItemMatchesText,
  type OrganizeChangeFilter
} from "./organize-review";

const crossCheckBatchSize = 20;

/** Names an apply after the filters that selected it, so the history says what each run was. */
export function applyRunLabel(changeFilter: OrganizeChangeFilter, textFilter: string, count: number) {
  const parts = [
    changeFilter === "all" ? "" : organizeChangeFilters.find((filter) => filter.id === changeFilter)?.label ?? "",
    textFilter.trim() ? `“${textFilter.trim()}”` : ""
  ].filter(Boolean);
  return `${parts.length ? parts.join(" · ") : "All ready moves"} · ${count.toLocaleString()} ${count === 1 ? "file" : "files"}`;
}

/** "Year: 212, Formatting only: 40", shown in the apply confirmation. */
export function summarizeChangeKinds(items: Array<OrganizePlan["items"][number]>) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const label = changeKindLabel(item.changeKind) || "Other";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts, ([label, count]) => `${label}: ${count.toLocaleString()}`).join(", ");
}

export type OrganizePreviewFilter = "attention" | "metadata-review" | "navidrome-unmatched" | "skipped" | "ready" | "duplicate-target" | "conflict" | "missing" | "trackkeep" | "same" | "all";
export type OrganizePreviewItem = OrganizePlan["items"][number];
export type SpotifyResolvableItem = Pick<
  TrackFile,
  "id" | "albumArtist" | "album" | "artist" | "title" | "managedBy" | "organizeSkippedAt" | "metadataConfidence" | "metadataSuggestion" | "identification"
>;

export const organizePreviewPageSize = 150;
export const organizePreviewFilters: Array<{ id: OrganizePreviewFilter; label: string }> = [
  { id: "attention", label: "Needs action" },
  { id: "metadata-review", label: "Identity review" },
  { id: "navidrome-unmatched", label: "Navidrome unmatched" },
  { id: "skipped", label: "Skipped" },
  { id: "ready", label: "Ready" },
  { id: "duplicate-target", label: "Duplicates" },
  { id: "conflict", label: "Conflicts" },
  { id: "missing", label: "Missing" },
  { id: "trackkeep", label: "TrackKeep" },
  { id: "same", label: "Organized" },
  { id: "all", label: "All" }
];

export function OrganizePage({ stats, onChanged }: { stats: LibraryStats | null; onChanged: () => Promise<void> }) {
  const [plan, setPlan] = useState<OrganizePlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applyErrors, setApplyErrors] = useState<string[]>([]);
  const [organizeFilter, setOrganizeFilter] = useState<OrganizePreviewFilter>("attention");
  const [pageIndex, setPageIndex] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [trashBusyKey, setTrashBusyKey] = useState<string | null>(null);
  const [selectedTrashCandidates, setSelectedTrashCandidates] = useState<Record<string, string>>({});
  const [changeFilter, setChangeFilter] = useState<OrganizeChangeFilter>("all");
  const [textFilter, setTextFilter] = useState("");
  const [runs, setRuns] = useState<OrganizeRunSummary[]>([]);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [crossCheckProgress, setCrossCheckProgress] = useState<{ done: number; total: number } | null>(null);
  const crossCheckStop = useRef(false);
  const previewRequestId = useRef(0);
  const lastScanFinishedAtRef = useRef<string | null | undefined>(undefined);
  const workflow = stats?.workflow;
  const lastScanFinishedAt = stats?.lastScanFinishedAt ?? null;
  const workflowSummary = workflowBlockerSummary(workflow);
  const organizeItems = plan?.items || [];
  const filterCounts = useMemo(() => countOrganizePreviewFilters(organizeItems), [organizeItems]);
  const visibleOrganizeFilters = useMemo(
    () => organizePreviewFilters.filter((filter) => {
      if (filter.id === "trackkeep") {
        return filterCounts.trackkeep > 0;
      }

      if (filter.id === "navidrome-unmatched") {
        return filterCounts["navidrome-unmatched"] > 0;
      }

      return true;
    }),
    [filterCounts]
  );
  const primaryOrganizeFilters = visibleOrganizeFilters.filter((filter) => ["attention", "metadata-review", "ready", "all"].includes(filter.id));
  const secondaryOrganizeFilters = visibleOrganizeFilters.filter((filter) => !primaryOrganizeFilters.includes(filter));
  const secondaryFilterSelected = secondaryOrganizeFilters.some((filter) => filter.id === organizeFilter);
  const statusItems = useMemo(
    () => organizeItems.filter((item) => organizePreviewItemMatchesFilter(item, organizeFilter) && organizeItemMatchesText(item, textFilter)),
    [organizeFilter, organizeItems, textFilter]
  );
  const changeCounts = useMemo(() => countOrganizeChangeFilters(statusItems), [statusItems]);
  const filteredItems = useMemo(
    () => statusItems.filter((item) => organizeItemMatchesChangeFilter(item, changeFilter)),
    [changeFilter, statusItems]
  );
  // Apply acts on what the reviewer is looking at: every ready item that passes the current filters.
  const readyInView = useMemo(() => filteredItems.filter((item) => item.status === "ready"), [filteredItems]);
  const applyingSubset = Boolean(plan) && readyInView.length !== plan?.summary.ready;
  const uncheckedInView = useMemo(
    () => filteredItems.filter((item) => item.targetRelativePath && item.status !== "same" && !item.crossCheck),
    [filteredItems]
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

  const showMutationPlan = (nextPlan: OrganizePlan) => {
    // A completed mutation is authoritative over any older preview still in flight.
    previewRequestId.current += 1;
    setPreviewBusy(false);
    showPlan(nextPlan);
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

  const loadRuns = async () => {
    try {
      setRuns(await api<OrganizeRunSummary[]>("/organize/runs"));
    } catch {
      // History is optional; the preview still works without it.
    }
  };

  useEffect(() => {
    void load({ quick: true });
    void loadRuns();
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
    if (!plan || readyInView.length === 0) {
      return;
    }

    const label = applyRunLabel(changeFilter, textFilter, readyInView.length);
    const breakdown = summarizeChangeKinds(readyInView);
    if (!window.confirm(
      `Move and retag ${readyInView.length.toLocaleString()} ${pluralize("file", readyInView.length)} (${breakdown})?\n\n` +
      "The old paths and tags are recorded, so this run can be undone from Organize history."
    )) {
      return;
    }

    setApplyBusy(true);
    previewRequestId.current += 1;
    setPreviewBusy(false);
    setNotice(null);
    setApplyErrors([]);
    setLastRunId(null);
    try {
      const result = await api<OrganizeApplyResult>("/organize/apply", {
        method: "POST",
        body: JSON.stringify({
          fingerprint: plan.fingerprint,
          label,
          ...(applyingSubset ? { itemIds: readyInView.map((item) => item.id) } : {})
        })
      });
      const errorSuffix = result.errors.length ? `, ${result.errors.length} errors` : "";
      setNotice(`${result.moved} moved${errorSuffix}. Preview refreshed.`);
      setApplyErrors(result.errors);
      setLastRunId(result.runId ?? null);

      await load({ clearNotice: false, resetPlan: true });
      await loadRuns();
    } catch (caught) {
      // A 409 means the plan changed since it was reviewed; show the refreshed plan instead.
      const changedPlan = caught instanceof ApiError && caught.status === 409
        ? (caught.body as { plan?: OrganizePlan } | null)?.plan
        : undefined;

      if (changedPlan) {
        showMutationPlan(changedPlan);
      }
      setNotice((caught as Error).message);
    } finally {
      setApplyBusy(false);
    }
  };

  const undoRun = async (run: OrganizeRunSummary) => {
    if (!window.confirm(`Undo "${run.label}"? ${run.undoable.toLocaleString()} ${pluralize("file", run.undoable)} will go back to their old paths and tags.`)) {
      return;
    }

    previewRequestId.current += 1;
    setPreviewBusy(false);
    setNotice(null);
    setApplyErrors([]);
    try {
      const result = await api<OrganizeUndoResult>(`/organize/runs/${encodeURIComponent(run.id)}/undo`, { method: "POST" });
      const errorSuffix = result.errors.length ? `, ${result.errors.length} left in place` : "";
      setNotice(`Undo restored ${result.restored.toLocaleString()} ${pluralize("file", result.restored)}${errorSuffix}.`);
      setApplyErrors(result.errors);
      setRuns(result.runs);
      setLastRunId(null);
      showMutationPlan(result.plan);
      await onChanged();
    } catch (caught) {
      setNotice((caught as Error).message);
    }
  };

  const crossCheck = async () => {
    const pending = uncheckedInView.map((item) => item.id);
    if (pending.length === 0) {
      return;
    }

    crossCheckStop.current = false;
    setCrossCheckProgress({ done: 0, total: pending.length });
    setNotice(null);
    const errors: string[] = [];
    let attempted = 0;
    let checked = 0;
    const tally = { agrees: 0, differs: 0, other: 0 };

    try {
      for (let index = 0; index < pending.length && !crossCheckStop.current; index += crossCheckBatchSize) {
        const batch = pending.slice(index, index + crossCheckBatchSize);
        const result = await api<OrganizeCrossCheckResult>("/organize/crosscheck", {
          method: "POST",
          body: JSON.stringify({ itemIds: batch })
        });
        errors.push(...result.errors);
        attempted += batch.length;
        checked += result.checked;
        for (const check of Object.values(result.results)) {
          tally[check.status === "agrees" ? "agrees" : check.status === "differs" ? "differs" : "other"] += 1;
        }
        setCrossCheckProgress({ done: attempted, total: pending.length });
        setPlan((current) => current && {
          ...current,
          items: current.items.map((item) => result.results[item.id] ? { ...item, crossCheck: result.results[item.id] } : item)
        });
      }
      setNotice(
        `${crossCheckStop.current ? "Cross-check stopped" : "Cross-check finished"}: ${checked.toLocaleString()} of ${pending.length.toLocaleString()} checked. ` +
        `Spotify agrees on ${tally.agrees.toLocaleString()}, differs on ${tally.differs.toLocaleString()}, ` +
        `could not find ${tally.other.toLocaleString()}.${tally.differs > 0 ? ' Use the "Spotify disagrees" filter to review them.' : ""}`
      );
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setApplyErrors(errors);
      setCrossCheckProgress(null);
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
      <div className="toolbar">
        <div className="organize-toolbar-copy">
          <strong>{plan ? `${filteredItems.length.toLocaleString()} ${organizePreviewFilters.find((item) => item.id === organizeFilter)?.label.toLowerCase()}` : previewBusy ? "Building preview" : "Organization preview"}</strong>
          <span>{plan ? `${plan.summary.ready} ready to apply · ${plan.summary.metadataReview} need identity review` : workflow?.message || "Review proposed changes before applying them."}</span>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load({ resetPlan: true })} disabled={previewBusy || applyBusy || Boolean(trashBusyKey)}>
            {previewBusy ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{previewBusy ? "Previewing" : "Preview"}</span>
          </button>
          {selectedTrashSelections.length > 0 && (
            <button className="danger-button" type="button" onClick={trashSelectedCandidates} disabled={previewBusy || applyBusy || Boolean(trashBusyKey)}>
              {trashBusyKey ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>{trashBusyKey ? "Moving" : `Trash ${selectedTrashSelections.length}`}</span>
            </button>
          )}
          {crossCheckProgress ? (
            <button className="secondary-button" type="button" onClick={() => { crossCheckStop.current = true; }}>
              <Loader2 className="spin" size={18} />
              <span>{`Checked ${crossCheckProgress.done}/${crossCheckProgress.total} · Stop`}</span>
            </button>
          ) : (
            uncheckedInView.length > 0 && (
              <button
                className="secondary-button"
                type="button"
                onClick={() => void crossCheck()}
                disabled={previewBusy || applyBusy || Boolean(trashBusyKey)}
                title="Look up each shown track on Spotify (by ISRC first) and flag any disagreement. Nothing is changed."
              >
                <ShieldCheck size={18} />
                <span>{`Cross-check ${uncheckedInView.length.toLocaleString()} with Spotify`}</span>
              </button>
            )
          )}
          <button
            className="primary-button"
            type="button"
            onClick={apply}
            disabled={previewBusy || applyBusy || Boolean(trashBusyKey) || Boolean(crossCheckProgress) || readyInView.length === 0}
            title={applyingSubset ? "Applies only the ready items that match the current filters" : "Applies every ready item"}
          >
            {applyBusy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
            <span>{applyBusy ? "Applying" : applyingSubset ? `Apply ${readyInView.length.toLocaleString()} shown` : `Apply all ${readyInView.length.toLocaleString()}`}</span>
          </button>
        </div>
      </div>
      {(previewBusy || applyBusy || trashBusyKey) && (
        <ActionProgress
          label={trashBusyKey ? "Moving selected files to recycle bin" : applyBusy ? "Applying organization plan" : "Building organization preview"}
        />
      )}
      {notice && (
        <div className="notice-bar">
          {notice}
          {lastRunId && runs.find((run) => run.id === lastRunId && run.undoable > 0) && (
            <button
              className="secondary-button compact-button notice-undo"
              type="button"
              onClick={() => void undoRun(runs.find((run) => run.id === lastRunId)!)}
            >
              <Undo2 size={16} />
              <span>Undo this run</span>
            </button>
          )}
        </div>
      )}
      <OrganizeHistory runs={runs} disabled={previewBusy || applyBusy || Boolean(trashBusyKey)} onUndo={undoRun} />
      {plan?.warnings?.length ? (
        <details className="organizer-notes">
          <summary>{plan.warnings.length} index {pluralize("note", plan.warnings.length)}</summary>
          {plan.warnings.slice(0, 3).map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
          {plan.warnings.length > 3 && <span>{plan.warnings.length - 3} more warnings</span>}
        </details>
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
            <div className="organize-filter-row">
              <div className="segmented-control organize-filter" role="radiogroup" aria-label="Preview status">
              {primaryOrganizeFilters.map((filter) => (
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
              {secondaryOrganizeFilters.length > 0 && (
                <label className="filter-select organize-more-filter" title={`${filterCounts.trackkeep} TrackKeep-protected tracks`}>
                  <SlidersHorizontal size={17} />
                  <select
                    aria-label="More preview filters"
                    value={secondaryFilterSelected ? organizeFilter : ""}
                    onChange={(event) => {
                      if (event.target.value) {
                        setOrganizeFilter(event.target.value as OrganizePreviewFilter);
                        setPageIndex(0);
                      }
                    }}
                  >
                    <option value="">More filters</option>
                    {secondaryOrganizeFilters.map((filter) => (
                      <option key={filter.id} value={filter.id}>{filter.label} ({filterCounts[filter.id].toLocaleString()})</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {pageCount > 1 && <div className="pagination-controls" aria-label="Preview pages">
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
            <ChangeFilterBar
              counts={changeCounts}
              value={changeFilter}
              text={textFilter}
              onChange={(value) => {
                setChangeFilter(value);
                setPageIndex(0);
              }}
              onTextChange={(value) => {
                setTextFilter(value);
                setPageIndex(0);
              }}
            />
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
                    <th>Status</th>
                    <th>Current → proposed</th>
                    <th>Resolve</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <StatusPill active={item.status === "ready"} label={organizeChangeLabel(item)} />
                        {item.changeKind && item.changeKind !== "none" && (
                          <span className={`change-kind change-kind-${item.changeKind}`}>{changeKindLabel(item.changeKind)}</span>
                        )}
                        {item.status !== "ready" && item.status !== "same" && (
                          <span className="status-detail">{item.message}</span>
                        )}
                        {item.status === "same" && isTrackKeepManaged(item.managedBy) && (
                          <span className="status-detail">{item.message}</span>
                        )}
                      </td>
                      <td className="organize-path-change">
                        <span className="path-label">Current</span>
                        <PathDiff value={item.sourceRelativePath} compareTo={item.targetRelativePath} />
                        {item.targetRelativePath ? (
                          <>
                            <span className="path-change-arrow" aria-hidden="true">↓</span>
                            <span className="path-label">Proposed</span>
                            <PathDiff value={item.targetRelativePath} compareTo={item.sourceRelativePath} />
                            {item.changes?.length || item.changeKind === "layout"
                              ? <ChangeDetails item={item} />
                              : <span className="status-detail">{organizeMetadataSourceLabel(item)}</span>}
                            <CrossCheckBadge check={item.crossCheck} />
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
                        <div className="organize-resolve-actions">
                          {item.collision && (
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
                          )}
                          <SpotifyMetadataResolver
                            item={item}
                            disabled={previewBusy || applyBusy || Boolean(trashBusyKey)}
                            onResolved={(result) => {
                              showMutationPlan(result.plan);
                              setNotice(
                                `Spotify metadata selected for ${result.matchedTracks} ${pluralize("track", result.matchedTracks)} from ${result.selected.album}. Review the updated targets, then Apply.`
                              );
                            }}
                            onIdentified={(result) => {
                              showMutationPlan(result.plan);
                              setNotice("MusicBrainz identity confirmed. Review the updated target, then Apply.");
                            }}
                            onTrusted={(result) => {
                              showMutationPlan(result.plan);
                              setNotice(
                                `Trusted path metadata for ${result.trustedTracks} ${pluralize("track", result.trustedTracks)} in this folder. Review the updated targets, then Apply.`
                              );
                            }}
                            onSkipped={(result) => {
                              showMutationPlan(result.plan);
                              if (result.skipped) {
                                setOrganizeFilter("skipped");
                                setNotice("Track skipped. You can revisit it anytime from the Skipped section.");
                              } else {
                                setNotice("Track returned to organization review using the latest available metadata.");
                              }
                            }}
                          />
                        </div>
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

export function SpotifyMetadataResolver({
  item,
  disabled,
  onResolved,
  onIdentified,
  onTrusted,
  onSkipped
}: {
  item: SpotifyResolvableItem;
  disabled: boolean;
  onResolved: (result: OrganizeSpotifyMatchResult) => void;
  onIdentified?: (result: OrganizeIdentificationMatchResult) => void;
  onTrusted?: (result: OrganizeTrustPathResult) => void;
  onSkipped?: (result: OrganizeSkipResult) => void;
}) {
  const spotify = useSpotifyMetadataSearch(item, onResolved);
  const [trustBusy, setTrustBusy] = useState(false);
  const [skipBusy, setSkipBusy] = useState(false);
  const [identifyBusy, setIdentifyBusy] = useState<string | null>(null);
  const organizationSkipped = Boolean(item.organizeSkippedAt);
  const confirmedCandidateId = confirmedIdentificationCandidateId(item.identification);

  const confirmIdentification = async (candidateId: string) => {
    if (!onIdentified) {
      return;
    }
    setIdentifyBusy(candidateId);
    spotify.setError(null);
    try {
      const result = await api<OrganizeIdentificationMatchResult>("/organize/identify-match", {
        method: "POST",
        body: JSON.stringify({ localTrackId: item.id, candidateId })
      });
      onIdentified(result);
    } catch (caught) {
      spotify.setError((caught as Error).message);
    } finally {
      setIdentifyBusy(null);
    }
  };

  const trustFolder = async () => {
    if (!onTrusted) {
      return;
    }

    if (!window.confirm("Trust the artist and album inferred from this folder for every review-needed track in the folder?")) {
      return;
    }

    setTrustBusy(true);
    spotify.setError(null);
    try {
      const result = await api<OrganizeTrustPathResult>("/organize/trust-path", {
        method: "POST",
        body: JSON.stringify({ localTrackId: item.id })
      });
      onTrusted(result);
    } catch (caught) {
      spotify.setError((caught as Error).message);
    } finally {
      setTrustBusy(false);
    }
  };

  const setSkipped = async (skipped: boolean) => {
    if (!onSkipped) {
      return;
    }

    if (
      skipped &&
      !window.confirm("Skip this track instead of organizing it with unverified filename or folder metadata?")
    ) {
      return;
    }

    setSkipBusy(true);
    spotify.setError(null);
    try {
      const result = await api<OrganizeSkipResult>("/organize/skip", {
        method: "POST",
        body: JSON.stringify({ localTrackId: item.id, skipped })
      });
      onSkipped(result);
    } catch (caught) {
      spotify.setError((caught as Error).message);
    } finally {
      setSkipBusy(false);
    }
  };

  return (
    <div className="spotify-metadata-resolver">
      {!organizationSkipped && item.identification?.source === "musicbrainz" && Boolean(item.identification.candidates?.length) && (
        <div className={confirmedCandidateId ? "metadata-review-summary identification-confirmed" : "metadata-review-summary"}>
          <span className="status-detail">
            {confirmedCandidateId
              ? "Release confirmed — pick another to change it"
              : item.identification.candidateSource === "musicbrainz-search"
                ? "Found by MusicBrainz search — confirm the right release"
                : "Identified from the audio fingerprint"}
          </span>
          {item.identification.candidates?.slice(0, 6).map((candidate) => (
            <button
              className={
                candidate.id === confirmedCandidateId
                  ? "secondary-button compact-button identification-candidate selected"
                  : "secondary-button compact-button identification-candidate"
              }
              type="button"
              key={candidate.id}
              aria-pressed={candidate.id === confirmedCandidateId}
              disabled={disabled || Boolean(identifyBusy) || candidate.id === confirmedCandidateId}
              onClick={() => void confirmIdentification(candidate.id)}
              title={`MusicBrainz recording ${candidate.recordingId}${candidate.releaseId ? ` · release ${candidate.releaseId}` : ""}`}
            >
              {identifyBusy === candidate.id
                ? <Loader2 className="spin" size={16} />
                : candidate.id === confirmedCandidateId
                  ? <Check size={16} />
                  : <Fingerprint size={16} />}
              <span>
                {candidate.artist} — {candidate.title} · {candidate.album}
                {candidate.year ? ` (${candidate.year})` : ""}
                {candidate.trackNumber ? ` · #${candidate.trackNumber}` : ""}
                {` · ${Math.round(candidate.score * 100)}%`}
              </span>
            </button>
          ))}
        </div>
      )}
      {!isTrackKeepManaged(item.managedBy) && item.metadataConfidence === "path-suggestion" && !organizationSkipped && (
        <div className="metadata-review-summary">
          <span className="status-detail">Suggested from path — not verified</span>
          <strong>
            {item.metadataSuggestion?.artist || item.artist} · {item.metadataSuggestion?.album || item.album}
          </strong>
          {item.metadataSuggestion?.artist && item.metadataSuggestion.album && (
            <button
              className="secondary-button compact-button"
              type="button"
              disabled={disabled || trustBusy || skipBusy || spotify.busy || Boolean(spotify.selectingId)}
              onClick={() => void trustFolder()}
            >
              {trustBusy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
              <span>{trustBusy ? "Trusting" : "Trust this folder"}</span>
            </button>
          )}
        </div>
      )}
      {organizationSkipped && (
        <div className="metadata-review-summary">
          <span className="status-detail">Saved for later — no file changes will be made</span>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={disabled || skipBusy || spotify.busy || Boolean(spotify.selectingId)}
            onClick={() => void setSkipped(false)}
          >
            {skipBusy ? <Loader2 className="spin" size={16} /> : <Undo2 size={16} />}
            <span>{skipBusy ? "Retrying" : "Retry organization"}</span>
          </button>
        </div>
      )}
      {!organizationSkipped && (
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={disabled || trustBusy || skipBusy || spotify.busy || Boolean(spotify.selectingId)}
          onClick={() => void setSkipped(true)}
        >
          {skipBusy ? <Loader2 className="spin" size={16} /> : <FolderX size={16} />}
          <span>{skipBusy ? "Skipping" : "Skip track"}</span>
        </button>
      )}
      <SpotifyMetadataToggle disabled={disabled || trustBusy || skipBusy} spotify={spotify} />
      {spotify.error && !spotify.open && <span className="status-detail spotify-metadata-error">{spotify.error}</span>}
      {spotify.open && <SpotifyMetadataSearchPanel spotify={spotify} />}
    </div>
  );
}

export function useSpotifyMetadataSearch(
  item: SpotifyResolvableItem,
  onResolved: (result: OrganizeSpotifyMatchResult) => void
) {
  const knownArtist = /^(?:\[?unknown artist\]?|unknown)$/i.test(item.albumArtist || item.artist)
    ? ""
    : item.albumArtist || item.artist;
  const initialQuery = [knownArtist, item.title].filter(Boolean).join(" ");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(initialQuery);
  const [matches, setMatches] = useState<SpotifyMetadataMatch[]>([]);
  const [busy, setBusy] = useState(false);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = async (nextQuery = query) => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<SpotifyMetadataSearchResult>(
        `/spotify/tracks/search?trackId=${encodeURIComponent(item.id)}&query=${encodeURIComponent(nextQuery.trim())}`
      );
      setQuery(result.query);
      setMatches(result.matches);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const choose = async (match: SpotifyMetadataMatch) => {
    setSelectingId(match.id);
    setError(null);
    try {
      const result = await api<OrganizeSpotifyMatchResult>("/organize/spotify-match", {
        method: "POST",
        body: JSON.stringify({ localTrackId: item.id, spotifyTrackId: match.id })
      });

      const resolvedItem = result.plan.items.find((candidate) => candidate.id === item.id);
      if (!result.updatedTrackIds.includes(item.id) || resolvedItem?.metadataConfidence !== "spotify") {
        throw new Error("Spotify metadata was returned but the organizer preview did not update. Refresh the preview and try again.");
      }

      setOpen(false);
      setMatches([]);
      onResolved(result);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSelectingId(null);
    }
  };

  return {
    busy,
    choose,
    error,
    initialQuery,
    matches,
    open,
    query,
    search,
    selectingId,
    setError,
    setOpen,
    setQuery
  };
}

export type SpotifyMetadataSearchState = ReturnType<typeof useSpotifyMetadataSearch>;

export function SpotifyMetadataToggle({ disabled, spotify }: { disabled: boolean; spotify: SpotifyMetadataSearchState }) {
  return (
    <button
      className="secondary-button compact-button"
      type="button"
      disabled={disabled || spotify.busy || Boolean(spotify.selectingId)}
      onClick={() => {
        if (spotify.open) {
          spotify.setOpen(false);
          return;
        }
        spotify.setOpen(true);
        if (spotify.matches.length === 0) {
          void spotify.search(spotify.initialQuery);
        }
      }}
    >
      {spotify.busy || spotify.selectingId ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
      <span>{spotify.open ? "Close Spotify" : "Find on Spotify"}</span>
    </button>
  );
}

export function SpotifyMetadataSearchPanel({
  spotify,
  wide = false
}: {
  spotify: SpotifyMetadataSearchState;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "spotify-metadata-panel unindexed-spotify-panel" : "spotify-metadata-panel"}>
      <form
        className="spotify-metadata-search"
        onSubmit={(event) => {
          event.preventDefault();
          void spotify.search();
        }}
      >
        <input value={spotify.query} onChange={(event) => spotify.setQuery(event.target.value)} placeholder="Artist and track title" />
        <button className="secondary-button compact-button" type="submit" disabled={spotify.busy || !spotify.query.trim()}>
          {spotify.busy ? <Loader2 className="spin" size={16} /> : <Search size={16} />}
          <span>Search</span>
        </button>
      </form>
      <span className="status-detail">Choose the exact release. Matching tracks in this source folder will be corrected together.</span>
      {spotify.error && <span className="status-detail spotify-metadata-error">{spotify.error}</span>}
      {!spotify.busy && !spotify.error && spotify.matches.length === 0 && <span className="status-detail">No Spotify tracks found.</span>}
      <div className="spotify-metadata-results">
        {spotify.matches.map((match) => (
          <button
            className="spotify-metadata-match"
            type="button"
            key={match.id}
            disabled={Boolean(spotify.selectingId)}
            onClick={() => void spotify.choose(match)}
          >
            {match.imageUrl ? <img src={match.imageUrl} alt="" /> : <span className="spotify-metadata-artwork" aria-hidden="true" />}
            <span>
              <strong>{match.name}</strong>
              <small>{match.artists.join(", ")}</small>
              <small>{match.album}{match.releaseYear ? ` (${match.releaseYear})` : ""} · Track {match.trackNumber}</small>
            </span>
            {spotify.selectingId === match.id && <Loader2 className="spin" size={16} />}
          </button>
        ))}
      </div>
    </div>
  );
}

export function CollisionCandidates({
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

export function organizePreviewEmptyTitle(workflow?: LibraryStats["workflow"]) {
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

export function organizePreviewEmptyDescription(workflow?: LibraryStats["workflow"], blockerSummary = "") {
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

export function workflowBlockerSummary(workflow?: LibraryStats["workflow"]) {
  if (!workflow || workflow.stage !== "organize") {
    return "";
  }

  return [
    countWorkflowItem(workflow.pendingMoves, "move"),
    countWorkflowItem(workflow.organizationConflicts, "conflict"),
    countWorkflowItem(workflow.metadataReview, "identity review"),
    countWorkflowItem(workflow.missingFiles, "missing file")
  ].filter(Boolean).join(", ");
}

export function countWorkflowItem(count: number, noun: string) {
  if (count <= 0) {
    return "";
  }

  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function organizeMetadataSourceLabel(item: OrganizePreviewItem) {
  if (item.identification?.status === "trackkeep-confirmed") {
    return "TrackKeep identity";
  }

  if (item.identification?.status === "musicbrainz-tagged") {
    return "MusicBrainz IDs from the file's tags";
  }

  if (item.identification?.source === "musicbrainz") {
    if (item.identification.status === "user-confirmed") {
      return "User-confirmed MusicBrainz metadata";
    }
    return item.identification.candidateSource === "musicbrainz-search"
      ? "MusicBrainz search candidate"
      : "AcoustID / MusicBrainz candidate";
  }

  if (item.metadataConfidence === "path-suggestion") {
    return "Path suggestion — confirmation required";
  }

  if (item.targetSource === "navidrome") {
    return item.navidromeEnrichment?.matchMethod
      ? `Navidrome metadata (${navidromeMatchMethodLabel(item.navidromeEnrichment.matchMethod)})`
      : "Navidrome metadata";
  }

  if (item.targetSource === "spotify") {
    return "Spotify metadata";
  }

  if (item.targetSource === "musicbrainz") {
    return "MusicBrainz metadata";
  }

  if (item.status === "same" && item.sourceRelativePath === item.targetRelativePath) {
    return "Path-organized/local metadata";
  }

  return "Local metadata";
}

export function organizeNavidromeDiagnosticLabel(item: OrganizePreviewItem) {
  const diagnostic = item.navidromeEnrichment;

  if (!diagnostic || diagnostic.code === "matched") {
    return "";
  }

  return diagnostic.message;
}

export function countOrganizePreviewFilters(items: OrganizePreviewItem[]) {
  const counts: Record<OrganizePreviewFilter, number> = {
    attention: 0,
    "metadata-review": 0,
    "navidrome-unmatched": 0,
    skipped: 0,
    ready: 0,
    "duplicate-target": 0,
    conflict: 0,
    missing: 0,
    trackkeep: 0,
    same: 0,
    all: 0
  };

  for (const item of items) {
    counts.all += 1;

    if (item.navidromeEnrichment?.status === "unmatched") {
      counts["navidrome-unmatched"] += 1;
    }

    if (isTrackKeepManaged(item.managedBy)) {
      counts.trackkeep += 1;
    }

    if (item.organizeSkippedAt) {
      counts.skipped += 1;
    }

    if (item.status === "same") {
      counts.same += 1;
    } else if (item.status === "metadata-review") {
      counts["metadata-review"] += 1;
      counts.attention += 1;
    } else if (item.status === "duplicate-target") {
      counts["duplicate-target"] += 1;
    } else if (item.status !== "skipped") {
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

export function organizePreviewItemMatchesFilter(item: OrganizePreviewItem, filter: OrganizePreviewFilter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "attention") {
    return item.status !== "same" && item.status !== "skipped" && item.status !== "duplicate-target";
  }

  if (filter === "conflict") {
    return item.status === "conflict" || item.status === "outside-library";
  }

  if (filter === "metadata-review") {
    return item.status === "metadata-review";
  }

  if (filter === "navidrome-unmatched") {
    return item.navidromeEnrichment?.status === "unmatched";
  }

  if (filter === "skipped") {
    return Boolean(item.organizeSkippedAt);
  }

  if (filter === "missing") {
    return item.status === "missing-source";
  }

  if (filter === "trackkeep") {
    return isTrackKeepManaged(item.managedBy);
  }

  return item.status === filter;
}

export function selectOrganizeFilterAfterRefresh(current: OrganizePreviewFilter, plan: OrganizePlan) {
  const counts = countOrganizePreviewFilters(plan.items);

  if (counts[current] > 0) {
    return current;
  }

  if (counts.attention > 0) {
    return "attention";
  }

  return "all";
}

/**
 * The candidate a confirmed identity came from. Confirming keeps the candidate list so the release
 * can still be changed, so the list has to show which one is already in effect.
 */
export function confirmedIdentificationCandidateId(identification: TrackFile["identification"]) {
  if (
    !identification?.releaseId ||
    (identification.status !== "user-confirmed" && identification.status !== "fingerprint-and-release-confirmed")
  ) {
    return null;
  }

  // The first six are the ones shown; editions listed further down are not selectable.
  const candidates = identification.candidates?.slice(0, 6) ?? [];
  const sameRelease = candidates.filter((candidate) => candidate.releaseId === identification.releaseId);
  return (sameRelease.find((candidate) => candidate.recordingId === identification.recordingId) ?? sameRelease[0])?.id ?? null;
}

export function selectedOrganizeTrashSelections(
  items: OrganizePreviewItem[],
  selectedCandidates: Record<string, string>
): OrganizeTrashSelection[] {
  return Object.entries(selectedCandidates)
    .filter(([itemId, candidateId]) => itemHasCollisionCandidate(items, itemId, candidateId))
    .map(([itemId, candidateId]) => ({ itemId, candidateId }));
}

export function pruneSelectedTrashCandidates(items: OrganizePreviewItem[], selectedCandidates: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(selectedCandidates).filter(([itemId, candidateId]) =>
      itemHasCollisionCandidate(items, itemId, candidateId)
    )
  );
}

export function itemHasCollisionCandidate(items: OrganizePreviewItem[], itemId: string, candidateId: string) {
  return Boolean(
    items.find((item) =>
      item.id === itemId && item.collision?.candidates.some((candidate) => candidate.id === candidateId)
    )
  );
}

export function organizeChangeLabel(item: OrganizePlan["items"][number]) {
  if (item.status === "same") {
    if (isTrackKeepManaged(item.managedBy)) {
      return "TrackKeep";
    }

    return "Already organized";
  }

  if (item.status === "conflict") {
    return "Conflict";
  }

  if (item.status === "metadata-review") {
    return "Identity review";
  }

  if (item.status === "skipped") {
    return "Skipped";
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
