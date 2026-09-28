import path from "node:path";
import type { TrackFile, TrackMusicBrainzIds } from "../shared/types.js";
import { getDb, parseJson, pathKey, queryAll, transaction } from "./db.js";

export type MetadataOverrideSource = "spotify" | "trusted-path" | "musicbrainz";

export type MetadataOverride = {
  absolutePath: string;
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

export async function loadMetadataOverrides() {
  return new Map(
    queryAll<{ path_key: string; data: string }>("SELECT path_key, data FROM metadata_overrides")
      .map((row) => [row.path_key, parseJson<MetadataOverride>(row.data)] as const)
      .filter((entry): entry is readonly [string, MetadataOverride] => Boolean(entry[1]?.absolutePath && entry[1]?.metadata))
  );
}

export async function saveMetadataOverridesForTracks(tracks: TrackFile[], source: MetadataOverrideSource) {
  transaction(() => {
    const upsert = getDb().prepare("INSERT OR REPLACE INTO metadata_overrides (path_key, data) VALUES (?, ?)");
    for (const track of tracks) {
      upsert.run(pathKey(track.absolutePath), JSON.stringify(overrideFromTrack(track, source)));
    }
  });
}

export async function moveMetadataOverrides(
  moves: Array<{ sourcePath: string; targetPath: string }>
) {
  if (moves.length === 0) {
    return;
  }

  const overrides = await loadMetadataOverrides();

  transaction(() => {
    const db = getDb();
    const remove = db.prepare("DELETE FROM metadata_overrides WHERE path_key = ?");
    const upsert = db.prepare("INSERT OR REPLACE INTO metadata_overrides (path_key, data) VALUES (?, ?)");

    for (const move of moves) {
      const entry = overrides.get(pathKey(move.sourcePath));
      if (!entry) {
        continue;
      }

      remove.run(pathKey(move.sourcePath));
      upsert.run(pathKey(move.targetPath), JSON.stringify({ ...entry, absolutePath: path.resolve(move.targetPath) }));
    }
  });
}

export function validMetadataOverride(
  overrides: Map<string, MetadataOverride>,
  absolutePath: string,
  size: number
) {
  const entry = overrides.get(pathKey(absolutePath));
  return entry?.size === size ? entry : null;
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
