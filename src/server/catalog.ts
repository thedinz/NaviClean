import type { LibraryStats, TrackFile, WorkflowState } from "../shared/types.js";
import { getDb, kvGet, kvSet, parseJson, pathKey, queryAll, transaction } from "./db.js";
import { normalizeTrackKeepManagedBy } from "./trackkeep.js";

export type Catalog = {
  updatedAt: string | null;
  tracks: TrackFile[];
};

const updatedAtKey = "catalog.updatedAt";
let cachedCatalog: Catalog | null = null;

export async function loadCatalog(): Promise<Catalog> {
  if (!cachedCatalog) {
    const rows = queryAll<{ data: string }>("SELECT data FROM tracks");
    cachedCatalog = {
      updatedAt: kvGet<string | null>(updatedAtKey) ?? null,
      tracks: rows
        .map((row) => parseJson<TrackFile>(row.data))
        .filter((track): track is TrackFile => Boolean(track))
        .map(normalizeCatalogTrack)
    };
  }

  // Callers derive new arrays from the catalog; hand out a copy of the list so the cache stays intact.
  return { updatedAt: cachedCatalog.updatedAt, tracks: [...cachedCatalog.tracks] };
}

/** Replaces the whole catalog with `tracks`. */
export async function saveCatalog(tracks: TrackFile[]) {
  const normalized = tracks.map(normalizeCatalogTrack);
  const updatedAt = new Date().toISOString();

  transaction(() => {
    const db = getDb();
    db.exec("DELETE FROM tracks");
    const insert = db.prepare("INSERT OR REPLACE INTO tracks (id, path_key, data) VALUES (?, ?, ?)");
    for (const track of normalized) {
      insert.run(track.id, pathKey(track.absolutePath), JSON.stringify(track));
    }
    kvSet(updatedAtKey, updatedAt);
  });

  cachedCatalog = { updatedAt, tracks: normalized };
  return { updatedAt, tracks: [...normalized] };
}

/** Inserts or replaces individual tracks without rewriting the rest of the catalog. */
export async function upsertCatalogTracks(tracks: TrackFile[]) {
  if (tracks.length === 0) {
    return loadCatalog();
  }

  const normalized = tracks.map(normalizeCatalogTrack);
  const incomingIds = new Set(normalized.map((track) => track.id));
  const incomingPaths = new Set(normalized.map((track) => pathKey(track.absolutePath)));
  const updatedAt = new Date().toISOString();

  transaction(() => {
    const db = getDb();
    const removeByPath = db.prepare("DELETE FROM tracks WHERE path_key = ?");
    const insert = db.prepare("INSERT OR REPLACE INTO tracks (id, path_key, data) VALUES (?, ?, ?)");
    for (const track of normalized) {
      removeByPath.run(pathKey(track.absolutePath));
      insert.run(track.id, pathKey(track.absolutePath), JSON.stringify(track));
    }
    kvSet(updatedAtKey, updatedAt);
  });

  const current = await loadCatalog();
  const kept = current.tracks.filter(
    (track) => !incomingIds.has(track.id) && !incomingPaths.has(pathKey(track.absolutePath))
  );
  cachedCatalog = { updatedAt, tracks: [...kept, ...normalized] };
  return loadCatalog();
}

export async function removeTracksFromCatalog(ids: Set<string>) {
  const catalog = await loadCatalog();
  return saveCatalog(catalog.tracks.filter((track) => !ids.has(track.id)));
}

export function invalidateCatalogCache() {
  cachedCatalog = null;
}

export function createStats(
  tracks: TrackFile[],
  duplicateGroups: number,
  duplicateTracks: number,
  lastScanFinishedAt: string | null,
  workflow: WorkflowState
): LibraryStats {
  return {
    totalTracks: tracks.length,
    duplicateGroups,
    duplicateTracks,
    pendingMoves: workflow.pendingMoves,
    missingMetadata: tracks.filter((track) => track.issues.length > 0).length,
    lastScanFinishedAt,
    workflow
  };
}

function normalizeCatalogTrack(track: TrackFile) {
  return {
    ...track,
    albumType: typeof track.albumType === "string" ? track.albumType.trim() : "",
    managedBy: normalizeTrackKeepManagedBy(track.managedBy)
  };
}
