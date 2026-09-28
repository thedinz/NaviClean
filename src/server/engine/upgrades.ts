import type { DownloadTrack, TrackFile, UpgradeCandidate, UpgradeView } from "../../shared/types.js";
import { coverArtUrl } from "../musicbrainz.js";
import { qualitySettings, type PrivateSettings } from "../settings.js";
import { normalizeForMatch } from "../utils.js";
import { codecFamily } from "./verify.js";

/** Lossy library tracks below the per-codec quality floor set in Settings. */
export function listUpgradeCandidates(settings: PrivateSettings, tracks: TrackFile[]): UpgradeView {
  const floors = qualitySettings(settings).minimumBitrateKbps;
  const candidates: UpgradeCandidate[] = [];

  for (const track of tracks) {
    if (track.lossless || !track.bitrate) {
      continue;
    }
    const family = codecFamily(track.codec || track.extension.replace(".", ""));
    const bitrateKbps = Math.round(track.bitrate / 1000);
    const minimumKbps = floors[family];
    if (minimumKbps > 0 && bitrateKbps < minimumKbps) {
      candidates.push({
        track,
        codecFamily: family,
        bitrateKbps,
        minimumKbps,
        reason: `${bitrateKbps} kbps ${family.toUpperCase()} is below the ${minimumKbps} kbps floor.`
      });
    }
  }

  candidates.sort(
    (left, right) =>
      (left.track.albumArtist || left.track.artist).localeCompare(right.track.albumArtist || right.track.artist, undefined, { sensitivity: "base" }) ||
      left.track.album.localeCompare(right.track.album, undefined, { sensitivity: "base" }) ||
      (left.track.discNumber ?? 1) - (right.track.discNumber ?? 1) ||
      (left.track.trackNumber ?? 0) - (right.track.trackNumber ?? 0)
  );
  return { totalTracks: tracks.length, candidates };
}

/** Describes an existing library track as a download request, so a better copy can replace it. */
export function downloadTrackFromLibraryTrack(track: TrackFile): DownloadTrack {
  const ids = track.musicbrainz;
  const recordingId = ids?.recordingId ?? track.identification?.recordingId;
  const releaseGroupId = ids?.releaseGroupId ?? track.identification?.releaseGroupId;
  const releaseId = ids?.releaseId ?? track.identification?.releaseId;
  const albumKey = releaseGroupId ?? normalizeForMatch(`${track.albumArtist} ${track.album}`, { removeBracketedText: false });

  return {
    key: recordingId ? `mb:${recordingId}:${albumKey}` : `local:${track.id}`,
    catalog: "musicbrainz",
    title: track.title,
    artists: track.artist ? track.artist.split(/\s*[,;]\s*/).filter(Boolean) : [track.albumArtist],
    album: track.album,
    albumArtist: track.albumArtist || track.artist,
    albumType: track.albumType || "Album",
    trackNumber: track.trackNumber ?? 1,
    discNumber: track.discNumber ?? 1,
    trackTotal: track.trackTotal,
    discTotal: track.discTotal,
    releaseDate: track.year ? String(track.year) : "",
    releaseYear: track.year,
    durationMs: track.duration ? Math.round(track.duration * 1000) : 0,
    isrc: track.isrc ?? null,
    coverUrl: releaseId ? coverArtUrl("release", releaseId, 1200) : null,
    musicbrainz: recordingId || releaseId
      ? {
          ...ids,
          recordingId,
          releaseId,
          releaseGroupId
        }
      : undefined
  };
}
