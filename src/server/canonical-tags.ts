import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { TrackFile } from "../shared/types.js";

const execFileAsync = promisify(execFile);

export function canonicalMetadataArgs(track: TrackFile) {
  const trackNumber = fractionTag(track.trackNumber, track.trackTotal);
  const discNumber = fractionTag(track.discNumber, track.discTotal);
  const identification = track.identification;
  const values: Array<[string, string]> = [
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
    ["musicbrainz_trackid", identification?.recordingId || ""],
    ["musicbrainz_albumid", identification?.releaseId || ""],
    ["spotify_track_id", identification?.spotifyTrackId || ""],
    ["spotify_album_id", identification?.spotifyAlbumId || ""]
  ];

  return values.flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

export async function writeCanonicalTags(filePath: string, track: TrackFile) {
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
        ...canonicalMetadataArgs(track),
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

    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not write confirmed tags; the original file was left in place. ${details}`);
  }
}

function fractionTag(value: number | null, total: number | null) {
  if (!value) {
    return "";
  }

  return total && total >= value ? `${value}/${total}` : String(value);
}
