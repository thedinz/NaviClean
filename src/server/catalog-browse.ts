import type {
  CatalogArtistSummary,
  CatalogArtistView,
  CatalogEdition,
  CatalogReleaseGroup,
  CatalogReleaseView,
  CatalogTrack,
  DownloadTrack,
  SpotifyAlbumDetail,
  SpotifyTrackSummary,
  TrackFile
} from "../shared/types.js";
import { LibraryPresence } from "./engine/presence.js";
import { isFollowed } from "./engine/follows.js";
import {
  artistCreditIds,
  artistCreditName,
  browseMusicBrainzReleaseGroups,
  browseMusicBrainzReleases,
  coverArtUrl,
  getMusicBrainzArtist,
  getMusicBrainzRelease,
  getMusicBrainzReleaseGroup,
  mediumTracks,
  preferredRelease,
  releaseGroupTypeLabel,
  releaseTrackCount,
  releaseYear,
  searchMusicBrainzArtists,
  type MbArtist,
  type MbRelease,
  type MbReleaseGroup
} from "./musicbrainz.js";

/** MusicBrainz-first catalog views for Discover, annotated with what the library already holds. */

export async function searchCatalogArtists(query: string, libraryTracks: TrackFile[]): Promise<CatalogArtistSummary[]> {
  const presence = new LibraryPresence(libraryTracks);
  return (await searchMusicBrainzArtists(query)).map((artist) => artistSummary(artist, presence));
}

export async function catalogArtist(artistId: string, libraryTracks: TrackFile[]): Promise<CatalogArtistView> {
  const presence = new LibraryPresence(libraryTracks);
  const [artist, groups] = await Promise.all([getMusicBrainzArtist(artistId), browseMusicBrainzReleaseGroups(artistId)]);

  return {
    artist: {
      ...artistSummary(artist, presence),
      genres: (artist.genres ?? artist.tags ?? [])
        .sort((left, right) => right.count - left.count)
        .slice(0, 6)
        .map((genre) => genre.name)
    },
    followed: isFollowed(artistId),
    releaseGroups: groups
      .map((group) => releaseGroupView(group, artistCreditName(group["artist-credit"]) || artist.name, presence))
      .sort(compareReleaseGroups)
  };
}

/** A release group's preferred edition (or the chosen one) with per-track library presence. */
export async function catalogRelease(
  releaseGroupId: string,
  releaseId: string | null,
  libraryTracks: TrackFile[],
  queuedTrackKeys: Set<string>
): Promise<CatalogReleaseView> {
  const presence = new LibraryPresence(libraryTracks);
  const [group, releases] = await Promise.all([
    getMusicBrainzReleaseGroup(releaseGroupId),
    browseMusicBrainzReleases(releaseGroupId)
  ]);
  const preferred = preferredRelease(releases);
  const chosenId = releaseId && releases.some((release) => release.id === releaseId) ? releaseId : preferred?.id;
  if (!chosenId) {
    throw new Error("MusicBrainz lists no releases for this album yet.");
  }

  const release = await getMusicBrainzRelease(chosenId);
  const tracks = downloadTracksFromRelease(release);
  const catalogTracks: CatalogTrack[] = tracks.map((track) => ({
    id: track.musicbrainz?.releaseTrackId ?? track.key,
    recordingId: track.musicbrainz?.recordingId ?? "",
    title: track.title,
    artists: track.artists,
    discNumber: track.discNumber,
    trackNumber: track.trackNumber,
    duration: track.durationMs > 0 ? Math.round(track.durationMs / 1000) : null,
    isrc: track.isrc,
    present: Boolean(presence.find(track)),
    queued: queuedTrackKeys.has(track.key)
  }));
  const albumArtist = artistCreditName(release["artist-credit"]) || artistCreditName(group["artist-credit"]);

  return {
    releaseGroup: releaseGroupView(group, albumArtist, presence),
    release: {
      ...editionView(release),
      artist: albumArtist,
      artistIds: artistCreditIds(release["artist-credit"]),
      coverUrl: coverArtUrl("release", release.id),
      labels: (release["label-info"] ?? []).map((info) => info.label?.name).filter((name): name is string => Boolean(name))
    },
    preferredReleaseId: preferred?.id ?? chosenId,
    editions: releases.map(editionView).sort((left, right) => (left.date || "9999").localeCompare(right.date || "9999")),
    tracks: catalogTracks,
    localTrackCount: catalogTracks.filter((track) => track.present).length
  };
}

/** Every track on a MusicBrainz release as a download request. */
export function downloadTracksFromRelease(release: MbRelease): DownloadTrack[] {
  const group = release["release-group"];
  const albumArtist = artistCreditName(release["artist-credit"]) || "Unknown Artist";
  const albumArtistIds = artistCreditIds(release["artist-credit"]);
  const discTotal = release.media?.length ?? 1;
  const date = release.date || group?.["first-release-date"] || "";

  return (release.media ?? []).flatMap((medium, mediumIndex) =>
    mediumTracks(medium).map((track, trackIndex) => {
      const recording = track.recording;
      const credit = track["artist-credit"] ?? recording?.["artist-credit"];
      const artists = (credit ?? []).map((part) => part.name ?? part.artist?.name ?? "").filter(Boolean);
      const length = track.length ?? recording?.length ?? 0;
      return {
        key: recording?.id ? `mb:${recording.id}:${group?.id ?? release.id}` : `mb-track:${track.id}`,
        catalog: "musicbrainz" as const,
        title: track.title || recording?.title || "Unknown Track",
        artists: artists.length ? artists : [albumArtist],
        album: release.title,
        albumArtist,
        albumType: releaseGroupTypeLabel(group),
        trackNumber: track.position ?? trackIndex + 1,
        discNumber: medium.position ?? mediumIndex + 1,
        trackTotal: medium["track-count"] ?? mediumTracks(medium).length,
        discTotal,
        releaseDate: date,
        releaseYear: releaseYear(date),
        durationMs: length ?? 0,
        isrc: recording?.isrcs?.[0]?.toUpperCase() ?? null,
        coverUrl: coverArtUrl("release", release.id, 1200),
        musicbrainz: {
          recordingId: recording?.id,
          releaseTrackId: track.id,
          releaseId: release.id,
          releaseGroupId: group?.id,
          artistIds: artistCreditIds(credit),
          albumArtistIds
        }
      } satisfies DownloadTrack;
    })
  );
}

/** Tracks of a release, optionally narrowed to chosen release-track IDs. */
export async function downloadTracksForRelease(releaseId: string, releaseTrackIds?: string[]) {
  const release = await getMusicBrainzRelease(releaseId);
  const tracks = downloadTracksFromRelease(release);
  const selected = releaseTrackIds?.length
    ? tracks.filter((track) => releaseTrackIds.includes(track.musicbrainz?.releaseTrackId ?? track.key))
    : tracks;
  return { release, tracks: selected };
}

export function downloadTracksFromSpotifyAlbum(album: SpotifyAlbumDetail, tracks: SpotifyTrackSummary[]): DownloadTrack[] {
  const discTotal = Math.max(1, ...album.tracks.map((track) => track.discNumber));
  return tracks.map((track) => ({
    key: `spotify:${track.id}`,
    catalog: "spotify",
    title: track.name,
    artists: track.artists.length ? track.artists : [album.artist.name],
    album: album.name,
    albumArtist: album.artist.name,
    albumType: album.albumType,
    trackNumber: track.trackNumber,
    discNumber: track.discNumber,
    trackTotal: album.totalTracks,
    discTotal,
    releaseDate: album.releaseDate,
    releaseYear: album.releaseYear,
    durationMs: track.duration * 1000,
    isrc: track.isrc,
    coverUrl: album.imageUrl,
    spotify: { trackId: track.id, albumId: album.id, url: track.spotifyUrl }
  }));
}

function artistSummary(artist: MbArtist, presence: LibraryPresence): CatalogArtistSummary {
  const span = artist["life-span"];
  return {
    id: artist.id,
    name: artist.name,
    disambiguation: artist.disambiguation ?? "",
    country: artist.country ?? "",
    type: artist.type ?? "",
    score: artist.score ?? 100,
    lifeSpan: [span?.begin?.slice(0, 4), span?.ended ? span?.end?.slice(0, 4) ?? "?" : ""].filter(Boolean).join("–"),
    localTrackCount: presence.artistTrackCount(artist.name)
  };
}

function releaseGroupView(group: MbReleaseGroup, artist: string, presence: LibraryPresence): CatalogReleaseGroup {
  return {
    id: group.id,
    title: group.title,
    primaryType: group["primary-type"] ?? "Other",
    secondaryTypes: group["secondary-types"] ?? [],
    firstReleaseDate: group["first-release-date"] ?? "",
    year: releaseYear(group["first-release-date"]),
    coverUrl: coverArtUrl("release-group", group.id, 250),
    artistCredit: artist,
    localTrackCount: presence.albumTrackCount(group.id, artist, group.title)
  };
}

function editionView(release: MbRelease): CatalogEdition {
  return {
    id: release.id,
    title: release.title,
    date: release.date ?? "",
    country: release.country ?? "",
    status: release.status ?? "",
    formats: [...new Set((release.media ?? []).map((medium) => medium.format ?? "").filter(Boolean))],
    trackCount: releaseTrackCount(release),
    disambiguation: release.disambiguation ?? ""
  };
}

const primaryTypeOrder: Record<string, number> = { Album: 0, EP: 1, Single: 2, Broadcast: 3, Other: 4 };

function compareReleaseGroups(left: CatalogReleaseGroup, right: CatalogReleaseGroup) {
  const leftSecondary = left.secondaryTypes.length > 0 ? 1 : 0;
  const rightSecondary = right.secondaryTypes.length > 0 ? 1 : 0;
  return (
    leftSecondary - rightSecondary ||
    (primaryTypeOrder[left.primaryType] ?? 5) - (primaryTypeOrder[right.primaryType] ?? 5) ||
    (right.firstReleaseDate || "").localeCompare(left.firstReleaseDate || "")
  );
}
