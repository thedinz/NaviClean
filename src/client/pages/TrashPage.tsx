import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2
} from "lucide-react";
import type {
  RecycleBinDeleteResult,
  RecycleBinItem,
  RecycleBinRestoreResult,
  RecycleBinView
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState } from "../components/common";
import { formatBytes, formatDate } from "../lib/format";

export const trashAudioExtensions = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".ape",
  ".dff",
  ".dsf",
  ".flac",
  ".m4a",
  ".mka",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".wma"
]);
export const trashArtworkExtensions = new Set([".bmp", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".webp"]);
export const trashPlaylistExtensions = new Set([".m3u", ".m3u8", ".pls", ".xspf"]);
export const trashLyricsExtensions = new Set([".lrc"]);
export const trashMetadataExtensions = new Set([
  ".accurip",
  ".cue",
  ".log",
  ".md5",
  ".nfo",
  ".pdf",
  ".sfv",
  ".sha1",
  ".sha256",
  ".txt",
  ".url"
]);
export const trashArchiveExtensions = new Set([".7z", ".gz", ".rar", ".tar", ".zip"]);
export const trashVideoExtensions = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"]);
export const trashJunkExtensions = new Set([".bak", ".crdownload", ".part", ".tmp"]);

export function TrashPage() {
  const [view, setView] = useState<RecycleBinView | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"restore" | "selected" | "empty" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const items = view?.items || [];
  const typeOptions = useMemo(() => buildTrashTypeOptions(items), [items]);
  const filteredItems = useMemo(() => filterTrashItems(items, filter, typeFilter), [filter, items, typeFilter]);
  const selectedItems = filteredItems.filter((item) => selectedIds[item.id]);
  const allSelected = filteredItems.length > 0 && selectedItems.length === filteredItems.length;
  const filtersActive = Boolean(filter.trim()) || typeFilter !== "all";

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

  useEffect(() => {
    if (typeFilter !== "all" && !typeOptions.some((option) => option.key === typeFilter)) {
      setTypeFilter("all");
    }
  }, [typeFilter, typeOptions]);

  const toggleAll = () => {
    setSelectedIds((current) => {
      if (allSelected) {
        const next = { ...current };
        for (const item of filteredItems) {
          delete next[item.id];
        }
        return next;
      }

      return {
        ...current,
        ...Object.fromEntries(filteredItems.map((item) => [item.id, true]))
      };
    });
  };

  const toggleItem = (item: RecycleBinItem) => {
    setSelectedIds((current) => ({
      ...current,
      [item.id]: !current[item.id]
    }));
  };

  const restoreSelected = async () => {
    if (selectedItems.length === 0) {
      return;
    }

    if (!window.confirm(`Restore ${selectedItems.length} selected item(s) to their original library paths?`)) {
      return;
    }

    setBusy("restore");
    setNotice(null);
    setErrors([]);

    try {
      const result = await api<RecycleBinRestoreResult>("/recycle-bin/restore", {
        method: "POST",
        body: JSON.stringify({ ids: selectedItems.map((item) => item.id) })
      });
      setView(result.recycleBin);
      setSelectedIds({});
      setErrors(result.errors);
      setNotice(`${result.restoredFiles} restored (${formatBytes(result.restoredBytes)}).`);
    } catch (caught) {
      setNotice((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const deleteSelected = async () => {
    if (selectedItems.length === 0) {
      return;
    }

    if (!window.confirm(`Permanently delete ${selectedItems.length} selected item(s) from Trash?`)) {
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

    if (!window.confirm(`Permanently delete all ${view.totalFiles} item(s) from Trash?`)) {
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
      <div className="recycle-bin-context">
        <Trash2 size={17} />
        <span>{view?.recycleBinPath || "Loading recycle bin path"}</span>
      </div>
      {items.length > 0 ? <div className="toolbar trash-toolbar">
        <div className="summary-chips">
          <span>{view?.totalFiles || 0} items</span>
          <span>{formatBytes(view?.totalSize || 0)}</span>
          {filtersActive && <span>{filteredItems.length} shown</span>}
          {selectedItems.length > 0 && <span>{selectedItems.length} selected</span>}
        </div>
        <div className="search-box">
          <Search size={17} />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter trash" />
        </div>
        <div className="filter-select">
          <SlidersHorizontal size={17} />
          <select
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            disabled={items.length === 0}
            aria-label="Filter trash by type"
          >
            {typeOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label} ({option.count.toLocaleString()})
              </option>
            ))}
          </select>
        </div>
        <div className="button-row">
          <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || Boolean(busy)}>
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
          {selectedItems.length > 0 && <>
            <button className="secondary-button" type="button" onClick={restoreSelected} disabled={loading || Boolean(busy)}>
              {busy === "restore" ? <Loader2 className="spin" size={18} /> : <Undo2 size={18} />}
              <span>{busy === "restore" ? "Restoring" : `Restore ${selectedItems.length}`}</span>
            </button>
            <button className="danger-button" type="button" onClick={deleteSelected} disabled={loading || Boolean(busy)}>
              {busy === "selected" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
              <span>{busy === "selected" ? "Deleting" : `Delete ${selectedItems.length}`}</span>
            </button>
          </>}
          <button
            className="secondary-button empty-trash-button"
            type="button"
            onClick={emptyTrash}
            disabled={loading || Boolean(busy) || !view?.totalFiles}
          >
            {busy === "empty" ? <Loader2 className="spin" size={18} /> : <Trash2 size={18} />}
            <span>{busy === "empty" ? "Emptying" : "Empty trash"}</span>
          </button>
        </div>
      </div> : (
        <div className="toolbar empty-trash-toolbar">
          <span className="muted">Items moved by NaviClean can be restored here until they are permanently deleted.</span>
          <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || Boolean(busy)}>
            {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
        </div>
      )}
      {(loading || busy) && (
        <ActionProgress
          label={
            busy === "restore"
              ? "Restoring recycle bin items"
              : busy
                ? "Deleting recycle bin items"
                : "Loading recycle bin"
          }
        />
      )}
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
      ) : !loading && filteredItems.length === 0 ? (
        <EmptyState icon={Search} title="No matching trash items" />
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
              {filteredItems.map((item) => (
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
                    <span>{trashItemKindLabel(item)}</span>
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

export function buildTrashTypeOptions(items: RecycleBinItem[]) {
  const options = new Map<string, { key: string; label: string; count: number; rank: number }>();

  for (const item of items) {
    const type = trashItemType(item);
    const option = options.get(type.key) ?? { ...type, count: 0 };
    option.count += 1;
    options.set(type.key, option);
  }

  return [
    { key: "all", label: "All types", count: items.length, rank: -1 },
    ...Array.from(options.values()).sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label))
  ];
}

export function filterTrashItems(items: RecycleBinItem[], filter: string, typeFilter: string) {
  const query = filter.trim().toLowerCase();

  return items.filter((item) =>
    trashItemMatchesType(item, typeFilter) &&
    (!query ||
      [item.originalRelativePath, item.relativePath, item.deletedGroup, item.extension]
        .join(" ")
        .toLowerCase()
        .includes(query))
  );
}

export function trashItemMatchesType(item: RecycleBinItem, typeFilter: string) {
  return typeFilter === "all" || trashItemType(item).key === typeFilter;
}

export function trashItemType(item: RecycleBinItem) {
  if (item.itemType === "folder") {
    return { key: "folder", label: "Folders", rank: 0 };
  }

  const extension = item.extension.toLowerCase();

  if (trashAudioExtensions.has(extension)) {
    return { key: "audio", label: "Audio files", rank: 1 };
  }

  if (trashArtworkExtensions.has(extension)) {
    return { key: "artwork", label: "Artwork/images", rank: 2 };
  }

  if (trashMetadataExtensions.has(extension)) {
    return { key: "metadata", label: "Metadata/review", rank: 3 };
  }

  if (trashPlaylistExtensions.has(extension)) {
    return { key: "playlist", label: "Playlists", rank: 4 };
  }

  if (trashLyricsExtensions.has(extension)) {
    return { key: "lyrics", label: "Lyrics", rank: 5 };
  }

  if (trashArchiveExtensions.has(extension)) {
    return { key: "archive", label: "Archives", rank: 6 };
  }

  if (trashVideoExtensions.has(extension)) {
    return { key: "video", label: "Video files", rank: 7 };
  }

  if (trashJunkExtensions.has(extension)) {
    return { key: "junk", label: "Temporary/junk", rank: 8 };
  }

  if (!extension) {
    return { key: "extensionless", label: "No extension", rank: 9 };
  }

  return { key: "other", label: "Other files", rank: 10 };
}

export function trashItemKindLabel(item: RecycleBinItem) {
  if (item.itemType === "folder") {
    return "Folder";
  }

  return item.extension.replace(".", "").toUpperCase() || "File";
}
