import fs from "node:fs/promises";
import path from "node:path";
import type { DownloadTrack, TrackFile } from "../../shared/types.js";
import { musicBrainzMetadataPairs, tagFamily, writeTagLibMusicBrainzIds } from "../canonical-tags.js";
import { withIdentity } from "../identity.js";
import {
  downloadCoverImage,
  formatFfmpegError,
  providerDownloadProfile,
  providerMetadataArgsForSpotifyTrack,
  writeTaggedAudioFile,
  type CatalogProviderTrack,
  type ProviderDownloadFormat
} from "../providers.js";
import type { PrivateSettings } from "../settings.js";
import { sha1, toPosixRelative } from "../utils.js";

/** The catalog entry a finished download becomes, and the path the organizer would give it. */
export function downloadTrackToTrackFile(
  settings: PrivateSettings,
  track: DownloadTrack,
  format: ProviderDownloadFormat,
  file?: { absolutePath: string; size: number; mtimeMs: number }
): TrackFile {
  const root = path.resolve(settings.naming.libraryPath);
  const profile = providerDownloadProfile(settings, format);
  const duration = track.durationMs > 0 ? Math.round(track.durationMs / 1000) : null;
  const absolutePath = file?.absolutePath ?? path.join(root, ".naviclean", "planned", `${sha1(track.key)}${profile.extension}`);
  const artist = track.artists.join(", ") || track.albumArtist;
  const fromSpotify = track.catalog === "spotify" && track.spotify;

  const partial: TrackFile = {
    id: file ? sha1(`${absolutePath}:${file.size}:${Math.round(file.mtimeMs)}`) : sha1(`planned:${track.key}`),
    absolutePath,
    relativePath: toPosixRelative(root, absolutePath),
    extension: profile.extension,
    size: file?.size ?? 0,
    mtimeMs: file?.mtimeMs ?? 0,
    artist,
    albumArtist: track.albumArtist,
    album: track.album,
    albumType: track.albumType || "Album",
    title: track.title,
    trackNumber: track.trackNumber,
    trackTotal: track.trackTotal,
    discNumber: track.discNumber,
    discTotal: track.discTotal,
    year: track.releaseYear,
    duration,
    isrc: track.isrc,
    bitrate: profile.bitrate,
    sampleRate: null,
    bitsPerSample: null,
    codec: profile.codec,
    container: profile.container,
    lossless: false,
    duplicateKey: "",
    qualityScore: profile.qualityScore,
    targetPath: "",
    targetRelativePath: "",
    issues: [],
    ...(fromSpotify
      ? {
          managedBy: "trackkeep" as const,
          targetSource: "spotify" as const,
          metadataConfidence: "spotify" as const,
          identification: {
            status: "trackkeep-confirmed" as const,
            source: "trackkeep" as const,
            message: "TrackKeep identity tags are authoritative.",
            spotifyTrackId: track.spotify!.trackId,
            spotifyAlbumId: track.spotify!.albumId
          }
        }
      : {
          targetSource: "musicbrainz" as const,
          metadataConfidence: "musicbrainz" as const,
          musicbrainz: track.musicbrainz,
          identification: {
            status: "musicbrainz-tagged" as const,
            source: "musicbrainz" as const,
            message: "Downloaded from a MusicBrainz release and tagged with its identifiers.",
            recordingId: track.musicbrainz?.recordingId,
            releaseId: track.musicbrainz?.releaseId,
            releaseGroupId: track.musicbrainz?.releaseGroupId
          }
        })
  };

  return withIdentity(partial, settings);
}

export function downloadTrackToProviderTrack(track: DownloadTrack): CatalogProviderTrack {
  return {
    album: track.album,
    albumId: track.spotify?.albumId ?? "",
    albumArtist: track.albumArtist,
    albumImageUrl: track.coverUrl,
    albumReleaseDate: track.releaseDate,
    albumReleaseYear: track.releaseYear,
    albumTracksTotal: track.trackTotal ?? 0,
    albumType: track.albumType,
    artists: track.artists,
    discNumber: track.discNumber,
    durationMs: track.durationMs,
    id: track.spotify?.trackId ?? track.key,
    isrc: track.isrc,
    name: track.title,
    spotifyUrl: track.spotify?.url ?? "",
    trackNumber: track.trackNumber
  };
}

/** Descriptive tags plus MusicBrainz identifiers in each container's Picard-standard names. */
export function downloadMetadataArgs(track: DownloadTrack, extension: string) {
  if (track.catalog === "spotify" && track.spotify) {
    return providerMetadataArgsForSpotifyTrack(downloadTrackToProviderTrack(track));
  }

  const pairs: Array<[string, string]> = [
    ["title", track.title],
    ["artist", track.artists.join("; ") || track.albumArtist],
    ["album", track.album],
    ["album_artist", track.albumArtist],
    ["track", track.trackTotal ? `${track.trackNumber}/${track.trackTotal}` : String(track.trackNumber)],
    ["disc", track.discTotal ? `${track.discNumber}/${track.discTotal}` : String(track.discNumber)],
    ["releasetype", track.albumType]
  ];
  if (track.releaseDate || track.releaseYear) {
    pairs.push(["date", track.releaseDate || String(track.releaseYear)]);
  }
  if (track.isrc) {
    pairs.push(["isrc", track.isrc]);
  }
  if (track.albumType.toLowerCase() === "compilation") {
    pairs.push(["compilation", "1"]);
  }
  if (track.musicbrainz?.releaseId) {
    pairs.push(["comment", `MusicBrainz release: https://musicbrainz.org/release/${track.musicbrainz.releaseId}`]);
    pairs.push(...musicBrainzMetadataPairs(track.musicbrainz, tagFamily(extension)).filter(([, value]) => value));
  }

  return pairs.flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}

/** Tags a staged file in place with metadata, cover art, and MusicBrainz identifiers. */
export async function tagStagedDownload(stagedPath: string, track: DownloadTrack) {
  const parsed = path.parse(stagedPath);
  const tempPath = path.join(parsed.dir, `${parsed.name}.naviclean-tagging${parsed.ext}`);
  let coverPath: string | null = null;

  try {
    coverPath = await downloadCoverImage(parsed.dir, parsed.name, track.coverUrl);
    await writeTaggedAudioFile(stagedPath, tempPath, downloadMetadataArgs(track, parsed.ext), coverPath);
    if (track.musicbrainz) {
      writeTagLibMusicBrainzIds(tempPath, track.musicbrainz);
    }
    await fs.rename(tempPath, stagedPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw new Error(`Could not tag the downloaded audio: ${formatFfmpegError(error)}`);
  } finally {
    if (coverPath) {
      await fs.rm(coverPath, { force: true }).catch(() => undefined);
    }
  }
}
