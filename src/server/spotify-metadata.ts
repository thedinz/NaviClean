import path from "node:path";
import type { SpotifyMetadataMatch, SpotifyTrackSummary, TrackFile } from "../shared/types.js";
import { buildDuplicateKey } from "./matching.js";
import { targetForTrack } from "./organizer.js";
import type { PrivateSettings } from "./settings.js";
import { getSpotifyAlbumDetail, getSpotifyTrackMetadata } from "./spotify.js";
import { normalizeForMatch } from "./utils.js";

export type SpotifyMetadataResolution = {
  matchedTracks: number;
  selected: SpotifyMetadataMatch;
  tracks: TrackFile[];
  updatedTrackIds: string[];
};

export async function resolveTrackMetadataFromSpotify(
  settings: PrivateSettings,
  tracks: TrackFile[],
  localTrackId: string,
  spotifyTrackId: string
): Promise<SpotifyMetadataResolution> {
  const selectedLocalTrack = tracks.find((track) => track.id === localTrackId);

  if (!selectedLocalTrack) {
    throw new Error("The local track is no longer in the current scan. Refresh the organize preview and try again.");
  }

  const selected = await getSpotifyTrackMetadata(settings, spotifyTrackId);
  const album = await getSpotifyAlbumDetail(settings, tracks, selected.albumId);
  const selectedFolder = path.posix.dirname(selectedLocalTrack.relativePath.replace(/\\/g, "/"));
  const albumDiscTotal = Math.max(1, ...album.tracks.map((track) => track.discNumber));
  const updatedTrackIds: string[] = [];

  const nextTracks = tracks.map((track) => {
    if (path.posix.dirname(track.relativePath.replace(/\\/g, "/")) !== selectedFolder) {
      return track;
    }

    const spotifyTrack = track.id === localTrackId
      ? album.tracks.find((candidate) => candidate.id === selected.id) ?? spotifySummaryFromMatch(selected)
      : uniqueAlbumTrackMatch(track, album.tracks);

    if (!spotifyTrack) {
      return track;
    }

    updatedTrackIds.push(track.id);
    return trackWithSpotifyMetadata(track, spotifyTrack, {
      album: album.name,
      albumArtist: album.artist.name,
      albumType: album.albumType,
      discTotal: albumDiscTotal,
      releaseYear: album.releaseYear,
      totalTracks: album.totalTracks
    }, settings);
  });

  return {
    matchedTracks: updatedTrackIds.length,
    selected,
    tracks: nextTracks,
    updatedTrackIds
  };
}

function uniqueAlbumTrackMatch(localTrack: TrackFile, spotifyTracks: SpotifyTrackSummary[]) {
  const localTitle = normalizeForMatch(localTrack.title, { removeBracketedText: false });
  const matches = spotifyTracks.filter((track) => {
    if (normalizeForMatch(track.name, { removeBracketedText: false }) !== localTitle) {
      return false;
    }

    if (localTrack.trackNumber && localTrack.trackNumber !== track.trackNumber) {
      return false;
    }

    return !localTrack.discNumber || localTrack.discNumber === track.discNumber;
  });

  return matches.length === 1 ? matches[0] : null;
}

function trackWithSpotifyMetadata(
  track: TrackFile,
  spotifyTrack: SpotifyTrackSummary,
  album: {
    album: string;
    albumArtist: string;
    albumType: string;
    discTotal: number;
    releaseYear: number | null;
    totalTracks: number;
  },
  settings: PrivateSettings
) {
  const artist = spotifyTrack.artists.join(", ") || album.albumArtist;
  const issues = track.issues.filter((issue) =>
    ![
      "Missing artist",
      "Missing album",
      "Missing track number",
      "Embedded metadata used unknown placeholders; used structured path metadata",
      "Embedded metadata conflicted with structured path; used structured path metadata"
    ].includes(issue)
  );
  const partialTrack = {
    ...track,
    artist,
    albumArtist: album.albumArtist,
    album: album.album,
    albumType: album.albumType,
    title: spotifyTrack.name,
    trackNumber: spotifyTrack.trackNumber,
    trackTotal: album.totalTracks,
    discNumber: spotifyTrack.discNumber,
    discTotal: album.discTotal,
    year: album.releaseYear,
    isrc: spotifyTrack.isrc ?? track.isrc ?? null,
    duplicateKey: buildDuplicateKey({
      artist: album.albumArtist,
      album: album.album,
      albumType: album.albumType,
      title: spotifyTrack.name,
      trackNumber: spotifyTrack.trackNumber,
      discNumber: spotifyTrack.discNumber,
      year: album.releaseYear,
      duration: track.duration ?? spotifyTrack.duration,
      isrc: spotifyTrack.isrc ?? track.isrc ?? null
    }),
    issues,
    navidromeEnrichment: undefined,
    metadataConfidence: "spotify" as const,
    targetSource: "spotify" as const
  } satisfies TrackFile;
  const target = targetForTrack(partialTrack, settings);

  return {
    ...partialTrack,
    targetPath: target.targetPath,
    targetRelativePath: target.targetRelativePath
  };
}

function spotifySummaryFromMatch(match: SpotifyMetadataMatch): SpotifyTrackSummary {
  return {
    id: match.id,
    name: match.name,
    artists: match.artists,
    discNumber: match.discNumber,
    trackNumber: match.trackNumber,
    duration: match.duration,
    explicit: false,
    isrc: match.isrc,
    spotifyUrl: match.spotifyUrl,
    present: false
  };
}
