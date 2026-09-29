import path from "node:path";
import type { TrackFile, TrackMusicBrainzIds } from "../shared/types.js";
import { getDb, parseJson, pathKey, queryAll, transaction } from "./db.js";

/*
 * Everything the user decided about individual files: confirmed metadata (Spotify matches,
 * trusted folders, chosen MusicBrainz releases) and organize skips. Decisions are keyed by path
 * and follow the file whenever NaviClean moves, retags or converts it, so later scans keep them.
 */

export type MetadataOverrideSource = "spotify" | "trusted-path" | "musicbrainz";

export type MetadataOverride = {
  absolutePath: string;
  /** File size the metadata was confirmed against; a different file at the same path invalidates it. */
  size: number;
  source: MetadataOverrideSource;
  musicbrainz?: TrackMusicBrainzIds;
  metadata: Pick<
    TrackFile,
    | "artist"
    | "albumArtist"
    | "album"
    | "albumType"
    | "title"
    | "trackNumber"
    | "trackTotal"
    | "discNumber"
    | "discTotal"
    | "year"
    | "isrc"
  >;
};

export type TrackFileMove = {
  sourcePath: string;
  targetPath: string;
  /** Size of the file at its new path (retagging and conversion change it). */
  size: number;
};

export async function loadMetadataOverrides() {
  return new Map(
    queryAll<{ path_key: string; data: string }>("SELECT path_key, data FROM metadata_overrides")
      .map((row) => [row.path_key, parseJson<MetadataOverride>(row.data)] as const)
      .filter((entry): entry is readonly [string, MetadataOverride] => Boolean(entry[1]?.absolutePath && entry[1]?.metadata))
  );
}

export function validMetadataOverride(overrides: Map<string, MetadataOverride>, absolutePath: string, size: number) {
  const entry = overrides.get(pathKey(absolutePath));
  return entry?.size === size ? entry : null;
}

export async function saveMetadataOverridesForTracks(tracks: TrackFile[], source: MetadataOverrideSource) {
  transaction(() => {
    const upsert = getDb().prepare("INSERT OR REPLACE INTO metadata_overrides (path_key, data) VALUES (?, ?)");
    for (const track of tracks) {
      upsert.run(pathKey(track.absolutePath), JSON.stringify(overrideFromTrack(track, source)));
    }
  });
}

/** Skip timestamps keyed by path key. */
export function loadSkipDecisions() {
  return new Map(
    queryAll<{ path_key: string; skipped_at: string }>("SELECT path_key, skipped_at FROM organize_skips").map(
      (row) => [row.path_key, row.skipped_at] as const
    )
  );
}

export function skipDecisionFor(skips: Map<string, string>, absolutePath: string) {
  return skips.get(pathKey(absolutePath));
}

export function saveSkipDecision(track: Pick<TrackFile, "absolutePath" | "organizeSkippedAt">) {
  if (track.organizeSkippedAt) {
    getDb()
      .prepare("INSERT OR REPLACE INTO organize_skips (path_key, absolute_path, skipped_at) VALUES (?, ?, ?)")
      .run(pathKey(track.absolutePath), path.resolve(track.absolutePath), track.organizeSkippedAt);
  } else {
    getDb().prepare("DELETE FROM organize_skips WHERE path_key = ?").run(pathKey(track.absolutePath));
  }
}

/** Re-keys every decision for files that moved, recording their new size. */
export async function moveTrackDecisions(moves: TrackFileMove[]) {
  if (moves.length === 0) {
    return;
  }

  const overrides = await loadMetadataOverrides();

  transaction(() => {
    const db = getDb();
    const removeOverride = db.prepare("DELETE FROM metadata_overrides WHERE path_key = ?");
    const upsertOverride = db.prepare("INSERT OR REPLACE INTO metadata_overrides (path_key, data) VALUES (?, ?)");
    const moveSkip = db.prepare("UPDATE OR REPLACE organize_skips SET path_key = ?, absolute_path = ? WHERE path_key = ?");

    for (const move of moves) {
      const sourceKey = pathKey(move.sourcePath);
      const targetKey = pathKey(move.targetPath);
      const override = overrides.get(sourceKey);

      if (override) {
        removeOverride.run(sourceKey);
        upsertOverride.run(
          targetKey,
          JSON.stringify({ ...override, absolutePath: path.resolve(move.targetPath), size: move.size })
        );
      }

      moveSkip.run(targetKey, path.resolve(move.targetPath), sourceKey);
    }
  });
}

/** Drops decisions for files that are no longer in the library. */
export function pruneTrackDecisions(existingPaths: Iterable<string>) {
  const existing = new Set(Array.from(existingPaths, pathKey));

  transaction(() => {
    const db = getDb();
    for (const table of ["metadata_overrides", "organize_skips"] as const) {
      const remove = db.prepare(`DELETE FROM ${table} WHERE path_key = ?`);
      for (const row of db.prepare(`SELECT path_key FROM ${table}`).all() as Array<{ path_key: string }>) {
        if (!existing.has(row.path_key)) {
          remove.run(row.path_key);
        }
      }
    }
  });
}

function overrideFromTrack(track: TrackFile, source: MetadataOverrideSource): MetadataOverride {
  return {
    absolutePath: path.resolve(track.absolutePath),
    size: track.size,
    source,
    ...(source === "musicbrainz" && track.musicbrainz ? { musicbrainz: track.musicbrainz } : {}),
    metadata: {
      artist: track.artist,
      albumArtist: track.albumArtist,
      album: track.album,
      albumType: track.albumType,
      title: track.title,
      trackNumber: track.trackNumber,
      trackTotal: track.trackTotal,
      discNumber: track.discNumber,
      discTotal: track.discTotal,
      year: track.year,
      isrc: track.isrc ?? null
    }
  };
}
