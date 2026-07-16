import fs from "node:fs/promises";
import path from "node:path";
import type { TrackFile } from "../shared/types.js";
import { getDataDir } from "./settings.js";

export type MetadataOverrideSource = "spotify" | "trusted-path";

export type MetadataOverride = {
  absolutePath: string;
  size: number;
  source: MetadataOverrideSource;
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

type MetadataOverrideFile = {
  entries: MetadataOverride[];
};

const overridesPath = path.join(getDataDir(), "metadata-overrides.json");

export async function loadMetadataOverrides() {
  try {
    const parsed = JSON.parse(await fs.readFile(overridesPath, "utf8")) as MetadataOverrideFile;
    return new Map(
      (Array.isArray(parsed.entries) ? parsed.entries : [])
        .filter((entry) => entry?.absolutePath && entry?.metadata)
        .map((entry) => [overrideKey(entry.absolutePath), entry])
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Map<string, MetadataOverride>();
    }
    throw error;
  }
}

export async function saveMetadataOverridesForTracks(tracks: TrackFile[], source: MetadataOverrideSource) {
  const overrides = await loadMetadataOverrides();

  for (const track of tracks) {
    overrides.set(overrideKey(track.absolutePath), overrideFromTrack(track, source));
  }

  await writeMetadataOverrides(overrides);
}

export async function moveMetadataOverrides(
  moves: Array<{ sourcePath: string; targetPath: string }>
) {
  if (moves.length === 0) {
    return;
  }

  const overrides = await loadMetadataOverrides();
  let changed = false;

  for (const move of moves) {
    const entry = overrides.get(overrideKey(move.sourcePath));
    if (!entry) {
      continue;
    }

    overrides.delete(overrideKey(move.sourcePath));
    overrides.set(overrideKey(move.targetPath), { ...entry, absolutePath: path.resolve(move.targetPath) });
    changed = true;
  }

  if (changed) {
    await writeMetadataOverrides(overrides);
  }
}

export function validMetadataOverride(
  overrides: Map<string, MetadataOverride>,
  absolutePath: string,
  size: number
) {
  const entry = overrides.get(overrideKey(absolutePath));
  return entry?.size === size ? entry : null;
}

function overrideFromTrack(track: TrackFile, source: MetadataOverrideSource): MetadataOverride {
  return {
    absolutePath: path.resolve(track.absolutePath),
    size: track.size,
    source,
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

async function writeMetadataOverrides(overrides: Map<string, MetadataOverride>) {
  await fs.mkdir(path.dirname(overridesPath), { recursive: true });
  const tempPath = `${overridesPath}.tmp`;
  const payload: MetadataOverrideFile = {
    entries: Array.from(overrides.values()).sort((left, right) => left.absolutePath.localeCompare(right.absolutePath))
  };
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, overridesPath);
}

function overrideKey(value: string) {
  return path.resolve(value).toLowerCase();
}
