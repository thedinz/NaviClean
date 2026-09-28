import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Database,
  FolderInput,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Trash2
} from "lucide-react";
import type {
  DuplicateBulkResolveResult,
  DuplicateGroup,
  LibraryStats,
  TrackFile
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState } from "../components/common";
import { albumReleaseLabel, qualitySummary } from "../lib/format";
import { workflowBlockerSummary } from "./OrganizePage";

export function DuplicatesPage({
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
      <section className="panel workflow-gate">
        <ActionProgress label="Checking organization status" />
        <span className="muted">Refreshing the workflow before duplicate cleanup is opened.</span>
      </section>
    );
  }

  if (!workflow?.duplicateScanReady) {
    return (
      <section className="panel setup-state workflow-gate">
        {duplicateGateIcon === Database ? <Database size={28} /> : <LockKeyhole size={28} />}
        <strong>{duplicateGateEmptyTitle(workflow)}</strong>
        <span>{workflow?.message || duplicateGateEmptyDescription(workflow)}</span>
        {blockerSummary && <span>{blockerSummary}</span>}
        {workflow?.stage === "organize" && (
            <button className="primary-button" type="button" onClick={onOpenOrganize}>
              <FolderInput size={18} />
              <span>Review organization</span>
            </button>
        )}
      </section>
    );
  }

  return (
    <section className="stack">
      <p className="supporting-note">Select copies to recycle and keep at least one file in every group.</p>
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
          {selectedRemoveIds.length > 0 && (
            <button className="danger-button" type="button" onClick={trashSelected} disabled={loading || Boolean(busyKey)}>
              {busyKey === "bulk" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>{busyKey === "bulk" ? "Moving" : `Trash ${selectedRemoveIds.length} selected`}</span>
            </button>
          )}
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
              {groupSelectedRemoveIds.length > 0 && (
                <button className="danger-button" type="button" onClick={() => trashGroupSelected(group)} disabled={Boolean(busyKey)}>
                  {busyKey === group.key ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
                  <span>Trash {groupSelectedRemoveIds.length}</span>
                </button>
              )}
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

export function duplicateGateNoticeTitle(workflow?: LibraryStats["workflow"]) {
  if (!workflow) {
    return "Duplicate cleanup unavailable";
  }

  if (workflow.stage === "scan") {
    return workflow.scanned ? "Duplicates waiting on scan" : "Duplicates need a library scan";
  }

  return "Duplicates waiting on organization";
}

export function duplicateGateEmptyTitle(workflow?: LibraryStats["workflow"]) {
  if (!workflow) {
    return "Duplicate cleanup not ready";
  }

  if (workflow.stage === "scan") {
    return workflow.scanned ? "Scan still running" : "Scan library first";
  }

  return "Organization needs attention";
}

export function duplicateGateEmptyDescription(workflow?: LibraryStats["workflow"]) {
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

export function pruneSelectedDuplicateTrashIds(groups: DuplicateGroup[], selectedIds: Record<string, boolean>) {
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

export function duplicateTrashSelectionWouldRemoveGroup(
  group: DuplicateGroup,
  selectedIds: Record<string, boolean>,
  toggledTrackId: string
) {
  return group.tracks.every((track) => track.id === toggledTrackId || selectedIds[track.id]);
}
