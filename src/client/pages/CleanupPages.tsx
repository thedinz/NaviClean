import { Fragment, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileQuestion,
  FolderInput,
  FolderX,
  Loader2,
  RefreshCw,
  Trash2
} from "lucide-react";
import type {
  EmptyFolderDeleteResult,
  EmptyFolderExcludeResult,
  EmptyFolderItem,
  EmptyFolderPreview,
  NonMusicFileClassification,
  NonMusicFileGroup,
  NonMusicFileGroupDetail,
  NonMusicFileItem,
  NonMusicFileTrashResult,
  NonMusicTrashResult,
  NonMusicFilesView
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState, LibraryAccessError } from "../components/common";
import { formatBytes, pluralize } from "../lib/format";

export function EmptyFoldersPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [preview, setPreview] = useState<EmptyFolderPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<"load" | "delete" | "exclude" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const folders = preview?.folders || [];
  const selectedFolders = folders.filter((folder) => selectedIds[folder.id]);
  const allSelected = folders.length > 0 && selectedFolders.length === folders.length;
  const blockingErrors = [...(error ? [error] : []), ...errors];
  const hasBlockingError = !busy && folders.length === 0 && blockingErrors.length > 0;

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
        {hasBlockingError ? <span className="muted">Empty folder cleanup</span> : (
          <div className="summary-chips">
            <span>{preview?.total || 0} empty {pluralize("folder", preview?.total || 0)}</span>
            {selectedFolders.length > 0 && <span>{selectedFolders.length} selected</span>}
          </div>
        )}
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={Boolean(busy)}>
            {busy === "load" ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{busy === "load" ? "Finding" : "Refresh"}</span>
          </button>
          {selectedFolders.length > 0 && (
            <button className="danger-button" type="button" onClick={deleteSelected} disabled={Boolean(busy)}>
              {busy === "delete" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>{busy === "delete" ? "Moving" : `Move ${selectedFolders.length} to trash`}</span>
            </button>
          )}
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
      {!hasBlockingError && error && <p className="form-error">{error}</p>}
      {!hasBlockingError && errors.length > 0 && (
        <div className="error-list">
          {errors.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {errors.length > 8 && <span>{errors.length - 8} more errors</span>}
        </div>
      )}
      {hasBlockingError ? (
        <LibraryAccessError messages={blockingErrors} onOpenSettings={onOpenSettings} />
      ) : preview ? (
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

export function EmptyFoldersPanel({
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

export function NonMusicFilesPage({ onOpenSettings }: { onOpenSettings: () => void }) {
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
  const hasBlockingError = !loading && groups.length === 0 && (errors.length > 0 || (!view && Boolean(notice)));
  const blockingErrors = errors.length > 0 ? errors : notice ? [notice] : [];

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
        {hasBlockingError ? <span className="muted">Non-music inventory</span> : <>
          <div className="summary-chips">
            <span>{(view?.nonMusicFiles || 0).toLocaleString()} non-music files</span>
            <span>{formatBytes(view?.totalSize || 0)}</span>
            {selectedGroups.length > 0 && <span>{selectedGroups.length} selected</span>}
          </div>
          <span className="muted">Compared with {(view?.audioFiles || 0).toLocaleString()} indexed audio files</span>
        </>}
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || Boolean(busy)}>
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
          {selectedGroups.length > 0 && (
            <button className="danger-button" type="button" onClick={trashSelected} disabled={loading || Boolean(busy)}>
              {busy === "trash" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>{busy === "trash" ? "Moving" : `Move ${selectedFileCount.toLocaleString()} to trash`}</span>
            </button>
          )}
        </div>
      </div>
      {(loading || busy) && <ActionProgress label={busy ? "Moving non-music files to trash" : "Scanning non-music files"} />}
      {!hasBlockingError && notice && <div className="notice-bar">{notice}</div>}
      {!hasBlockingError && errors.length ? (
        <div className="error-list">
          {errors.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {errors.length > 8 && <span>{errors.length - 8} more errors</span>}
        </div>
      ) : null}
      {hasBlockingError ? (
        <LibraryAccessError messages={blockingErrors} onOpenSettings={onOpenSettings} />
      ) : !loading && groups.length === 0 ? (
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

export function NonMusicGroupDetailPanel({
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

export function nonMusicTrashNotice(result: NonMusicTrashResult) {
  const errorSuffix = result.errors.length ? ` (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})` : "";
  return `${result.trashed.toLocaleString()} non-music ${pluralize("file", result.trashed)} moved to trash (${formatBytes(result.trashedBytes)})${errorSuffix}.`;
}

export function emptyFolderDeleteNotice(result: EmptyFolderDeleteResult) {
  const errorSuffix = result.errors.length ? ` (${result.errors.length} issue${result.errors.length === 1 ? "" : "s"})` : "";
  const nextPass = result.emptyFolders.total;
  return `${result.deleted} empty ${pluralize("folder", result.deleted)} moved to Trash${errorSuffix}. ${nextPass} in the next pass.`;
}

export function nonMusicClassificationLabel(value: NonMusicFileClassification) {
  if (value === "useful") {
    return "Likely useful";
  }

  if (value === "junk") {
    return "Probably junk";
  }

  return "Review";
}
