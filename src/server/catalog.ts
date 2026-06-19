import fs from "node:fs/promises";
import path from "node:path";
import type { LibraryStats, TrackFile, WorkflowState } from "../shared/types.js";
import { getDataDir } from "./settings.js";

export type Catalog = {
  updatedAt: string | null;
  tracks: TrackFile[];
};

const catalogPath = path.join(getDataDir(), "catalog.json");

export async function loadCatalog(): Promise<Catalog> {
  try {
    const raw = await fs.readFile(catalogPath, "utf8");
    const parsed = JSON.parse(raw) as Catalog;
    return {
      updatedAt: parsed.updatedAt || null,
      tracks: Array.isArray(parsed.tracks) ? parsed.tracks.map(normalizeCatalogTrack) : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { updatedAt: null, tracks: [] };
    }
    throw error;
  }
}

export async function saveCatalog(tracks: TrackFile[]) {
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  const catalog: Catalog = {
    updatedAt: new Date().toISOString(),
    tracks
  };
  const tempPath = `${catalogPath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, catalogPath);
  return catalog;
}

export async function removeTracksFromCatalog(ids: Set<string>) {
  const catalog = await loadCatalog();
  const next = catalog.tracks.filter((track) => !ids.has(track.id));
  return saveCatalog(next);
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
    albumType: typeof track.albumType === "string" && track.albumType.trim() ? track.albumType : "Album"
  };
}

