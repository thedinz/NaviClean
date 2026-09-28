import type { DownloadTrack, TrackFile } from "../../shared/types.js";
import { normalizeForMatch } from "../utils.js";

/** Answers "is this track already in the library?" by MusicBrainz ID first, then by name. */
export class LibraryPresence {
  private readonly byRecording = new Map<string, TrackFile[]>();
  private readonly byName = new Map<string, TrackFile>();
  private readonly albumCounts = new Map<string, number>();

  constructor(tracks: TrackFile[]) {
    for (const track of tracks) {
      const recordingId = track.musicbrainz?.recordingId ?? track.identification?.recordingId;
      if (recordingId) {
        this.byRecording.set(recordingId, [...(this.byRecording.get(recordingId) ?? []), track]);
      }
      for (const artist of new Set([track.albumArtist, track.artist])) {
        this.byName.set(nameKey(artist, track.album, track.title), track);
      }
      const releaseGroupId = track.musicbrainz?.releaseGroupId ?? track.identification?.releaseGroupId;
      if (releaseGroupId) {
        this.albumCounts.set(`rg:${releaseGroupId}`, (this.albumCounts.get(`rg:${releaseGroupId}`) ?? 0) + 1);
      }
      const albumKey = `name:${normalize(track.albumArtist || track.artist)}|${normalize(track.album)}`;
      this.albumCounts.set(albumKey, (this.albumCounts.get(albumKey) ?? 0) + 1);
    }
  }

  find(track: Pick<DownloadTrack, "title" | "album" | "albumArtist" | "artists" | "musicbrainz">) {
    const recordingId = track.musicbrainz?.recordingId;
    if (recordingId) {
      const matches = this.byRecording.get(recordingId) ?? [];
      const releaseGroupId = track.musicbrainz?.releaseGroupId;
      const sameRelease = matches.find(
        (candidate) =>
          (releaseGroupId && (candidate.musicbrainz?.releaseGroupId ?? candidate.identification?.releaseGroupId) === releaseGroupId) ||
          normalize(candidate.album) === normalize(track.album)
      );
      if (sameRelease) {
        return sameRelease;
      }
    }

    for (const artist of [track.albumArtist, ...track.artists]) {
      const match = this.byName.get(nameKey(artist, track.album, track.title));
      if (match) {
        return match;
      }
    }
    return null;
  }

  albumTrackCount(releaseGroupId: string | null, artist: string, album: string) {
    return Math.max(
      releaseGroupId ? this.albumCounts.get(`rg:${releaseGroupId}`) ?? 0 : 0,
      this.albumCounts.get(`name:${normalize(artist)}|${normalize(album)}`) ?? 0
    );
  }

  artistTrackCount(artist: string) {
    const key = normalize(artist);
    let count = 0;
    for (const [albumKey, value] of this.albumCounts) {
      if (albumKey.startsWith(`name:${key}|`)) {
        count += value;
      }
    }
    return count;
  }
}

function nameKey(artist: string, album: string, title: string) {
  return [normalize(artist), normalize(album), normalize(title)].join("|");
}

function normalize(value: string) {
  return normalizeForMatch(value ?? "", { removeBracketedText: false }).replace(/^the /, "");
}
