import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { File as TagLibFile } from "node-taglib-sharp";
import type { TrackFile, TrackMusicBrainzIds } from "../shared/types.js";

const execFileAsync = promisify(execFile);

type TagFamily = "vorbis" | "id3" | "mp4" | "other";

const vorbisExtensions = new Set([".flac", ".ogg", ".oga", ".opus", ".spx"]);
const mp4Extensions = new Set([".m4a", ".m4b", ".mp4", ".alac", ".aac"]);

/** MusicBrainz identifiers for a track, preferring confirmed identification over raw tags. */
export function musicBrainzIdsForTrack(track: TrackFile): TrackMusicBrainzIds {
  const identification = track.identification;
  if (track.metadataConfidence === "spotify" || track.metadataConfidence === "trusted-path") {
    // The user chose non-MusicBrainz metadata, so any MusicBrainz IDs in the old tags may now be wrong.
    return {};
  }
  const tagged = track.musicbrainz ?? {};
  return {
    ...tagged,
    recordingId: identification?.recordingId || tagged.recordingId,
    releaseId: identification?.releaseId || tagged.releaseId,
    releaseGroupId: identification?.releaseGroupId || tagged.releaseGroupId
  };
}

export function canonicalMetadataArgs(track: TrackFile, extension = track.extension) {
  return metadataArgs(canonicalMetadataValues(track, extension));
}

function metadataArgs(values: Array<[string, string]>) {
  return values.flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

/** Every ffmpeg metadata key a canonical retag writes; an empty value deletes the tag. */
export function canonicalMetadataValues(track: TrackFile, extension = track.extension): Array<[string, string]> {
  const trackNumber = fractionTag(track.trackNumber, track.trackTotal);
  const discNumber = fractionTag(track.discNumber, track.discTotal);
  const identification = track.identification;
  return [
    ["title", track.title],
    ["artist", track.artist],
    ["album", track.album],
    ["album_artist", track.albumArtist],
    ["track", trackNumber],
    ["disc", discNumber],
    ["date", track.year ? String(track.year) : ""],
    ["isrc", track.isrc || ""],
    ["releasetype", track.albumType || ""],
    ["naviclean_identity_source", identification?.source || ""],
    ["naviclean_identity_status", identification?.status || ""],
    ["spotify_track_id", identification?.spotifyTrackId || ""],
    ["spotify_album_id", identification?.spotifyAlbumId || ""],
    ...musicBrainzMetadataPairs(musicBrainzIdsForTrack(track), tagFamily(extension))
  ];
}

/**
 * Picard's tag names per container. Vorbis comments and ID3 TXXX frames can be written by
 * ffmpeg; the ID3 recording ID (a UFID frame) and every MP4 freeform atom need taglib.
 */
export function musicBrainzMetadataPairs(ids: TrackMusicBrainzIds, family: TagFamily): Array<[string, string]> {
  if (family === "vorbis") {
    return [
      ["MUSICBRAINZ_TRACKID", ids.recordingId ?? ""],
      ["MUSICBRAINZ_RELEASETRACKID", ids.releaseTrackId ?? ""],
      ["MUSICBRAINZ_ALBUMID", ids.releaseId ?? ""],
      ["MUSICBRAINZ_RELEASEGROUPID", ids.releaseGroupId ?? ""],
      ["MUSICBRAINZ_ARTISTID", (ids.artistIds ?? []).join("; ")],
      ["MUSICBRAINZ_ALBUMARTISTID", (ids.albumArtistIds ?? []).join("; ")]
    ];
  }

  if (family === "id3") {
    return [
      ["MusicBrainz Release Track Id", ids.releaseTrackId ?? ""],
      ["MusicBrainz Album Id", ids.releaseId ?? ""],
      ["MusicBrainz Release Group Id", ids.releaseGroupId ?? ""],
      ["MusicBrainz Artist Id", (ids.artistIds ?? []).join("/")],
      ["MusicBrainz Album Artist Id", (ids.albumArtistIds ?? []).join("/")]
    ];
  }

  return [];
}

export async function writeCanonicalTags(filePath: string, track: TrackFile) {
  try {
    await rewriteMetadata(filePath, canonicalMetadataValues(track, path.extname(filePath)), (tempPath) => {
      writeTagLibMusicBrainzIds(tempPath, musicBrainzIdsForTrack(track));
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not write confirmed tags; the original file was left in place. ${details}`);
  }
}

/** The MusicBrainz IDs held in frames only taglib writes (ID3 UFID, MP4 freeform atoms). */
type TagLibIdSnapshot = {
  recordingId?: string;
  releaseId?: string;
  releaseGroupId?: string;
  artistId?: string;
  albumArtistId?: string;
};

/** The tags a canonical retag is about to overwrite, as they were before it; enough to undo it. */
export type TagSnapshot = {
  /** Original value of every key the retag writes; null when the file did not have that tag. */
  values: Record<string, string | null>;
  taglib?: TagLibIdSnapshot;
};

/** Records the current value of every tag that `writeCanonicalTags(filePath, track)` would change. */
export async function snapshotCanonicalTags(filePath: string, track: TrackFile): Promise<TagSnapshot> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "format_tags:stream_tags", "-of", "json", filePath],
    { maxBuffer: 1024 * 1024 * 4, timeout: 60_000 }
  );
  const probed = JSON.parse(stdout) as { format?: { tags?: Record<string, string> }; streams?: Array<{ tags?: Record<string, string> }> };
  // Ogg-family files keep their comments on the stream; everything else on the container.
  const existing = new Map<string, string>();
  for (const tags of [probed.streams?.[0]?.tags, probed.format?.tags]) {
    for (const [key, value] of Object.entries(tags ?? {})) {
      existing.set(key.toLowerCase(), String(value));
    }
  }

  const values: Record<string, string | null> = {};
  for (const [key] of canonicalMetadataValues(track, path.extname(filePath))) {
    values[key] = existing.get(key.toLowerCase()) ?? null;
  }
  const taglib = readTagLibIds(filePath);
  return taglib ? { values, taglib } : { values };
}

/** Puts back exactly the tags a canonical retag replaced, leaving every other tag as it is now. */
export async function restoreTagSnapshot(filePath: string, snapshot: TagSnapshot) {
  const values = Object.entries(snapshot.values).map(([key, value]): [string, string] => [key, value ?? ""]);
  await rewriteMetadata(filePath, values, (tempPath) => {
    if (snapshot.taglib) {
      writeTagLibIdSnapshot(tempPath, snapshot.taglib);
    }
  });
}

/** Rewrites container metadata into a temp file and swaps it in, so a failure never touches the original. */
async function rewriteMetadata(filePath: string, values: Array<[string, string]>, finish: (tempPath: string) => void) {
  const parsed = path.parse(filePath);
  const tempPath = path.join(
    parsed.dir,
    `${parsed.name}.naviclean-retag-${process.pid}-${Math.random().toString(36).slice(2, 10)}${parsed.ext}`
  );

  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        filePath,
        "-map",
        "0",
        "-map_metadata",
        "0",
        "-c",
        "copy",
        ...(parsed.ext.toLowerCase() === ".mp3" ? ["-id3v2_version", "3"] : []),
        ...metadataArgs(values),
        tempPath
      ],
      {
        maxBuffer: 1024 * 1024 * 4,
        timeout: 120_000
      }
    );

    const result = await fs.stat(tempPath);
    if (result.size <= 0) {
      throw new Error("ffmpeg produced an empty tagged file");
    }

    finish(tempPath);
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function readTagLibIds(filePath: string): TagLibIdSnapshot | undefined {
  const family = tagFamily(path.extname(filePath));
  if (family !== "id3" && family !== "mp4") {
    return undefined;
  }

  const file = TagLibFile.createFromPath(filePath);
  try {
    const tag = file.tag;
    return {
      recordingId: tag.musicBrainzTrackId || undefined,
      releaseId: tag.musicBrainzReleaseId || undefined,
      releaseGroupId: tag.musicBrainzReleaseGroupId || undefined,
      artistId: tag.musicBrainzArtistId || undefined,
      albumArtistId: tag.musicBrainzReleaseArtistId || undefined
    };
  } finally {
    file.dispose();
  }
}

function writeTagLibIdSnapshot(filePath: string, snapshot: TagLibIdSnapshot) {
  const family = tagFamily(path.extname(filePath));
  const file = TagLibFile.createFromPath(filePath);
  try {
    const tag = file.tag;
    // taglib removes a frame or atom when it is set to an empty value.
    tag.musicBrainzTrackId = snapshot.recordingId ?? "";
    if (family === "mp4") {
      tag.musicBrainzReleaseId = snapshot.releaseId ?? "";
      tag.musicBrainzReleaseGroupId = snapshot.releaseGroupId ?? "";
      tag.musicBrainzArtistId = snapshot.artistId ?? "";
      tag.musicBrainzReleaseArtistId = snapshot.albumArtistId ?? "";
    }
    file.save();
  } finally {
    file.dispose();
  }
}

/** Writes the MusicBrainz IDs that ffmpeg cannot express for MP3 (UFID) and MP4 (freeform atoms). */
export function writeTagLibMusicBrainzIds(filePath: string, ids: TrackMusicBrainzIds) {
  const family = tagFamily(path.extname(filePath));
  if ((family !== "id3" && family !== "mp4") || !hasAnyId(ids)) {
    return;
  }

  const file = TagLibFile.createFromPath(filePath);
  try {
    const tag = file.tag;
    if (ids.recordingId) tag.musicBrainzTrackId = ids.recordingId;
    if (family === "mp4") {
      if (ids.releaseId) tag.musicBrainzReleaseId = ids.releaseId;
      if (ids.releaseGroupId) tag.musicBrainzReleaseGroupId = ids.releaseGroupId;
      if (ids.artistIds?.length) tag.musicBrainzArtistId = ids.artistIds.join("/");
      if (ids.albumArtistIds?.length) tag.musicBrainzReleaseArtistId = ids.albumArtistIds.join("/");
    }
    file.save();
  } finally {
    file.dispose();
  }
}

export function tagFamily(extension: string): TagFamily {
  const normalized = extension.toLowerCase().startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
  if (vorbisExtensions.has(normalized)) return "vorbis";
  if (normalized === ".mp3") return "id3";
  if (mp4Extensions.has(normalized)) return "mp4";
  return "other";
}

function hasAnyId(ids: TrackMusicBrainzIds) {
  return Boolean(ids.recordingId || ids.releaseId || ids.releaseGroupId || ids.artistIds?.length || ids.albumArtistIds?.length);
}

function fractionTag(value: number | null, total: number | null) {
  if (!value) {
    return "";
  }

  return total && total >= value ? `${value}/${total}` : String(value);
}
