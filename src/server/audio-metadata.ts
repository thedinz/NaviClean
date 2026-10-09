import { parseFile } from "music-metadata";
import type { TrackMusicBrainzIds } from "../shared/types.js";
import { getDb, parseJson, pathKey, queryOne, transaction } from "./db.js";

/**
 * The subset of parsed tags the scanner uses. Binary frames are decoded to short text or
 * dropped so the same shape can be cached and re-read without touching the file again.
 */
export type AudioMetadata = {
  common: Record<string, unknown>;
  native: Record<string, Array<{ id: string; value: unknown }>>;
  format: {
    bitrate?: number;
    bitsPerSample?: number;
    codec?: string;
    container?: string;
    duration?: number;
    lossless?: boolean;
    sampleRate?: number;
  };
};

type FileStamp = { size: number; mtimeMs: number };
type CachedMetadata = { version: number; metadata: AudioMetadata };

// Bump when the slimmed shape changes so older cache rows are re-read.
const cacheVersion = 1;
const maxDecodedBinaryBytes = 4096;
const maxNativeValueDepth = 4;

export class AudioMetadataCache {
  private readonly pending = new Map<string, { stamp: FileStamp; metadata: AudioMetadata }>();
  hits = 0;
  misses = 0;

  lookup(filePath: string, stamp: FileStamp): AudioMetadata | null {
    const row = queryOne<{ size: number; mtime_ms: number; data: string }>(
      "SELECT size, mtime_ms, data FROM metadata_cache WHERE path_key = ?",
      pathKey(filePath)
    );
    if (!row || row.size !== stamp.size || row.mtime_ms !== stamp.mtimeMs) {
      return null;
    }
    const cached = parseJson<CachedMetadata>(row.data);
    return cached?.version === cacheVersion ? cached.metadata : null;
  }

  store(filePath: string, stamp: FileStamp, metadata: AudioMetadata) {
    this.pending.set(pathKey(filePath), { stamp, metadata });
    if (this.pending.size >= 500) {
      this.flush();
    }
  }

  flush() {
    if (this.pending.size === 0) {
      return;
    }

    transaction(() => {
      const upsert = getDb().prepare(
        "INSERT OR REPLACE INTO metadata_cache (path_key, size, mtime_ms, data, cached_at) VALUES (?, ?, ?, ?, ?)"
      );
      const now = Date.now();
      for (const [key, { stamp, metadata }] of this.pending) {
        upsert.run(key, stamp.size, stamp.mtimeMs, JSON.stringify({ version: cacheVersion, metadata } satisfies CachedMetadata), now);
      }
    });
    this.pending.clear();
  }
}

/** Reads tags through the cache; unchanged files (same size and mtime) are never re-parsed. */
export async function readAudioMetadata(filePath: string, stamp: FileStamp, cache?: AudioMetadataCache) {
  const cached = cache?.lookup(filePath, stamp);
  if (cached) {
    cache!.hits += 1;
    return cached;
  }

  const parsed = await parseFile(filePath, { duration: true, skipCovers: true });
  const metadata = slimAudioMetadata(parsed);
  if (cache) {
    cache.misses += 1;
    cache.store(filePath, stamp, metadata);
  }
  return metadata;
}

export function slimAudioMetadata(parsed: Awaited<ReturnType<typeof parseFile>>): AudioMetadata {
  const common: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.common as unknown as Record<string, unknown>)) {
    if (key === "picture") {
      continue;
    }
    const slim = slimValue(value, 0);
    if (slim !== undefined) {
      common[key] = slim;
    }
  }

  const native: AudioMetadata["native"] = {};
  for (const [tagType, tags] of Object.entries(parsed.native ?? {})) {
    native[tagType] = tags
      .filter((tag) => !isPictureTag(tag.id))
      .map((tag) => ({ id: tag.id, value: slimValue(tag.value, 0) }))
      .filter((tag) => tag.value !== undefined);
  }

  const format = parsed.format;
  return {
    common,
    native,
    format: {
      bitrate: finiteNumber(format.bitrate),
      bitsPerSample: finiteNumber(format.bitsPerSample),
      codec: typeof format.codec === "string" ? format.codec : undefined,
      container: typeof format.container === "string" ? format.container : undefined,
      duration: finiteNumber(format.duration),
      lossless: typeof format.lossless === "boolean" ? format.lossless : undefined,
      sampleRate: finiteNumber(format.sampleRate)
    }
  };
}

const mbidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** MusicBrainz identifiers written by Picard, beets, or NaviClean itself. Invalid values are ignored. */
export function musicBrainzIdsFromMetadata(metadata: AudioMetadata | null): TrackMusicBrainzIds | undefined {
  const common = metadata?.common;
  if (!common) {
    return undefined;
  }

  const ids: TrackMusicBrainzIds = {
    recordingId: mbid(common.musicbrainz_recordingid),
    releaseTrackId: mbid(common.musicbrainz_trackid),
    releaseId: mbid(common.musicbrainz_albumid),
    releaseGroupId: mbid(common.musicbrainz_releasegroupid),
    artistIds: mbidList(common.musicbrainz_artistid),
    albumArtistIds: mbidList(common.musicbrainz_albumartistid)
  };

  if (!ids.recordingId && !ids.releaseId && !ids.releaseGroupId) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(ids).filter(([, value]) => (Array.isArray(value) ? value.length > 0 : Boolean(value)))
  ) as TrackMusicBrainzIds;
}

function mbid(value: unknown) {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && mbidPattern.test(text.trim()) ? text.trim().toLowerCase() : undefined;
}

function mbidList(value: unknown) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;/]/) : [];
  return Array.from(new Set(values.map(mbid).filter((item): item is string => Boolean(item))));
}

function slimValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (value instanceof Uint8Array) {
    return value.length <= maxDecodedBinaryBytes ? new TextDecoder().decode(value) : undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (depth >= maxNativeValueDepth) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => slimValue(item, depth + 1)).filter((item) => item !== undefined);
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, slimValue(item, depth + 1)] as const)
      .filter(([, item]) => item !== undefined);
    return Object.fromEntries(entries);
  }

  return undefined;
}

function isPictureTag(id: string) {
  const normalized = id.toUpperCase();
  return normalized === "APIC" || normalized === "PIC" || normalized === "METADATA_BLOCK_PICTURE" || normalized === "COVR" || normalized.endsWith(":COVR") || normalized === "PICTURE";
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
