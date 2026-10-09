import path from "node:path";
import { isConfirmedIdentityStatus } from "../shared/identity.js";
import type { TrackFile, TrackIdentificationCandidate } from "../shared/types.js";
import {
  artistCreditIds,
  artistCreditName,
  getMusicBrainzRelease,
  mediumTracks,
  musicBrainzRequestCount,
  releaseGroupTypeLabel,
  releaseYear,
  searchMusicBrainzRecordings,
  searchMusicBrainzReleases,
  textSimilarity,
  type MbRecording,
  type MbRelease
} from "./musicbrainz.js";
import { musicBrainzSettings, type PrivateSettings } from "./settings.js";
import { isTrackKeepManaged } from "./trackkeep.js";
import { sha1 } from "./utils.js";

/** Text-search candidates never reach the automatic-confirmation threshold; a person confirms them. */
const maxTextCandidateScore = 0.9;
const minimumCandidateScore = 0.6;
const releaseSearchLimit = 5;
const releasesExaminedPerFolder = 2;

/**
 * Tier 2 identification: searches MusicBrainz by the file's tag and path hints for tracks the
 * fingerprint tier could not place. Searches run per album folder (one release search plus one
 * tracklist lookup per candidate release) so a whole album costs a few requests, not one per track.
 */
export async function identifyByMusicBrainzText(
  settings: PrivateSettings,
  tracks: TrackFile[],
  onProgress?: (processed: number) => void,
  signal?: AbortSignal,
  onStart?: (total: number) => void
) {
  const options = musicBrainzSettings(settings);
  const warnings: string[] = [];

  if (!options.textSearchEnabled || !settings.identification.useEmbeddedTagsAsHints) {
    return { tracks, warnings, identified: 0 };
  }

  const eligible = tracks.filter(needsTextSearch);
  if (eligible.length === 0) {
    return { tracks, warnings, identified: 0 };
  }

  onStart?.(eligible.length);
  onProgress?.(0);
  const startRequests = musicBrainzRequestCount();
  const budgetExhausted = () => musicBrainzRequestCount() - startRequests >= options.maxTextLookupsPerScan;
  const byFolder = new Map<string, TrackFile[]>();
  for (const track of eligible) {
    const folder = path.posix.dirname(track.relativePath.replace(/\\/g, "/"));
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), track]);
  }

  const candidatesByTrackId = new Map<string, TrackIdentificationCandidate[]>();
  let processed = 0;
  let skippedForBudget = 0;
  let failures = 0;

  for (const folderTracks of byFolder.values()) {
    if (signal?.aborted) {
      break;
    }
    if (budgetExhausted()) {
      skippedForBudget += folderTracks.length;
      continue;
    }

    try {
      const albumHint = commonValue(folderTracks.map((track) => usableHint(track.album)));
      const artistHint = commonValue(folderTracks.map((track) => usableHint(track.albumArtist) || usableHint(track.artist)));

      if (albumHint) {
        const found = await releaseCandidatesForFolder(folderTracks, albumHint, artistHint, budgetExhausted);
        for (const [trackId, candidates] of found) {
          candidatesByTrackId.set(trackId, candidates);
        }
      }

      for (const track of folderTracks) {
        if (candidatesByTrackId.has(track.id) || budgetExhausted() || signal?.aborted) {
          continue;
        }
        const candidates = await recordingCandidatesForTrack(track);
        if (candidates.length > 0) {
          candidatesByTrackId.set(track.id, candidates);
        }
      }
    } catch {
      failures += folderTracks.length;
    }

    processed += folderTracks.length;
    onProgress?.(processed);
  }

  let identified = 0;
  const nextTracks = tracks.map((track) => {
    const candidates = candidatesByTrackId.get(track.id);
    if (!candidates?.length) {
      return track;
    }
    identified += 1;
    return {
      ...track,
      identification: {
        status: "recording-identified-release-ambiguous" as const,
        source: "musicbrainz" as const,
        message: "MusicBrainz text search found likely releases from the file's tags. Confirm the right release.",
        fingerprint: track.identification?.fingerprint,
        candidates,
        candidateSource: "musicbrainz-search" as const
      }
    };
  });

  if (identified > 0) {
    warnings.push(`MusicBrainz search: found likely releases for ${identified.toLocaleString()} tracks; confirm them under Organize → Identity review.`);
  }
  if (skippedForBudget > 0) {
    warnings.push(
      `MusicBrainz search: ${skippedForBudget.toLocaleString()} tracks were left for the next scan to respect the per-scan lookup limit (${options.maxTextLookupsPerScan}).`
    );
  }
  if (failures > 0) {
    warnings.push(`MusicBrainz search: lookups failed for ${failures.toLocaleString()} tracks; they will be retried next scan.`);
  }

  return { tracks: nextTracks, warnings, identified };
}

function needsTextSearch(track: TrackFile) {
  const identification = track.identification;
  if (isTrackKeepManaged(track.managedBy) || isConfirmedIdentityStatus(identification?.status)) {
    return false;
  }
  if (identification?.status === "fingerprint-and-release-confirmed") {
    return false;
  }
  if (identification?.candidates?.length) {
    return false;
  }
  return Boolean(usableHint(track.title) && (usableHint(track.artist) || usableHint(track.albumArtist)));
}

async function releaseCandidatesForFolder(
  tracks: TrackFile[],
  album: string,
  artist: string | null,
  budgetExhausted: () => boolean
) {
  const results = new Map<string, TrackIdentificationCandidate[]>();
  const { releases } = await searchMusicBrainzReleases({ album, artist: artist ?? undefined }, releaseSearchLimit);
  const plausible = releases
    .map((release) => ({
      release,
      score: (release.score ?? 0) / 100 * 0.4 +
        textSimilarity(album, release.title) * 0.35 +
        (artist ? textSimilarity(artist, artistCreditName(release["artist-credit"])) : 0.5) * 0.25
    }))
    .filter((entry) => entry.score >= 0.7)
    .sort((left, right) => right.score - left.score)
    .slice(0, releasesExaminedPerFolder);

  for (const { release: summary, score: releaseScore } of plausible) {
    if (budgetExhausted()) {
      break;
    }
    const release = await getMusicBrainzRelease(summary.id);

    for (const track of tracks) {
      const match = bestReleaseTrack(track, release);
      if (!match) {
        continue;
      }
      const score = Math.min(maxTextCandidateScore, releaseScore * 0.35 + match.score * 0.65);
      if (score < minimumCandidateScore) {
        continue;
      }
      const candidate = candidateFromReleaseTrack(release, match.mediumIndex, match.trackIndex, score);
      if (candidate) {
        results.set(track.id, [...(results.get(track.id) ?? []), candidate].sort((left, right) => right.score - left.score));
      }
    }
  }

  return results;
}

async function recordingCandidatesForTrack(track: TrackFile) {
  const artist = usableHint(track.artist) || usableHint(track.albumArtist) || undefined;
  // The album hint only affects scoring: path-derived album names ("misc", "Downloads")
  // would otherwise filter out every real recording.
  let { recordings } = await searchMusicBrainzRecordings(
    { artist, title: track.title, durationSeconds: track.duration },
    recordingSearchLimit
  );
  if (recordings.length === 0 && track.duration) {
    // Nothing within the length window (a live cut, a bad rip): fall back to title and artist.
    ({ recordings } = await searchMusicBrainzRecordings({ artist, title: track.title }, recordingSearchLimit));
  }

  const candidates: TrackIdentificationCandidate[] = [];
  for (const recording of recordings) {
    const titleScore = textSimilarity(track.title, recording.title);
    const artistScore = artist ? textSimilarity(artist, artistCreditName(recording["artist-credit"])) : 0.5;
    const durationScore = durationSimilarity(track.duration, recording.length);
    const base = titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.2;
    if (base < minimumCandidateScore || titleScore < 0.7) {
      continue;
    }

    for (const release of rankReleasesForRecording(recording.releases ?? []).slice(0, 4)) {
      const albumScore = usableHint(track.album) ? textSimilarity(track.album, release.title) : 0.5;
      const score = Math.min(maxTextCandidateScore, base * 0.8 + albumScore * 0.2 + releasePreference(release));
      const candidate = candidateFromRecordingRelease(recording, release, score);
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  // One candidate per album: editions of the same release group are the same choice to a person.
  const perGroup = new Map<string, TrackIdentificationCandidate>();
  for (const candidate of dedupeCandidates(candidates)) {
    const key = candidate.releaseGroupId ?? candidate.releaseId ?? candidate.id;
    if (!perGroup.has(key)) {
      perGroup.set(key, candidate);
    }
  }
  return [...perGroup.values()].slice(0, 6);
}

export const recordingSearchLimit = 12;

function bestReleaseTrack(track: TrackFile, release: MbRelease) {
  let best: { mediumIndex: number; trackIndex: number; score: number } | null = null;

  (release.media ?? []).forEach((medium, mediumIndex) => {
    mediumTracks(medium).forEach((releaseTrack, trackIndex) => {
      const titleScore = textSimilarity(track.title, releaseTrack.title);
      if (titleScore < 0.75) {
        return;
      }
      const positionMatches =
        track.trackNumber === releaseTrack.position &&
        (track.discNumber ?? 1) === (medium.position ?? 1);
      const durationScore = durationSimilarity(track.duration, releaseTrack.length ?? releaseTrack.recording?.length);
      const score = titleScore * 0.6 + durationScore * 0.25 + (positionMatches ? 0.15 : 0);
      if (!best || score > best.score) {
        best = { mediumIndex, trackIndex, score };
      }
    });
  });

  return best as { mediumIndex: number; trackIndex: number; score: number } | null;
}

export function candidateFromReleaseTrack(
  release: MbRelease,
  mediumIndex: number,
  trackIndex: number,
  score: number
): TrackIdentificationCandidate | null {
  const medium = release.media?.[mediumIndex];
  const releaseTrack = medium ? mediumTracks(medium)[trackIndex] : undefined;
  const recording = releaseTrack?.recording;
  if (!medium || !releaseTrack || !recording?.id) {
    return null;
  }

  const trackCredit = releaseTrack["artist-credit"] ?? recording["artist-credit"];
  const albumArtist = artistCreditName(release["artist-credit"]);
  const discNumber = medium.position ?? mediumIndex + 1;
  const trackNumber = releaseTrack.position ?? trackIndex + 1;

  return {
    id: sha1([recording.id, release.id, discNumber, trackNumber].join(":")),
    score,
    acoustId: "",
    recordingId: recording.id,
    releaseId: release.id,
    releaseGroupId: release["release-group"]?.id ?? null,
    releaseTrackId: releaseTrack.id,
    artist: artistCreditName(trackCredit) || albumArtist,
    albumArtist: albumArtist || artistCreditName(trackCredit),
    artistIds: artistCreditIds(trackCredit),
    albumArtistIds: artistCreditIds(release["artist-credit"]),
    album: release.title,
    albumType: releaseGroupTypeLabel(release["release-group"]),
    title: releaseTrack.title || recording.title,
    trackNumber,
    trackTotal: medium["track-count"] ?? mediumTracks(medium).length,
    discNumber,
    discTotal: release.media?.length ?? 1,
    year: releaseYear(release.date ?? release["release-group"]?.["first-release-date"]),
    originalYear: releaseYear(release["release-group"]?.["first-release-date"]),
    duration: (releaseTrack.length ?? recording.length) ? Math.round((releaseTrack.length ?? recording.length ?? 0) / 1000) : null,
    isrc: recording.isrcs?.[0]?.toUpperCase() ?? null
  };
}

function candidateFromRecordingRelease(
  recording: MbRecording,
  release: MbRelease,
  score: number
): TrackIdentificationCandidate | null {
  const mediumIndex = (release.media ?? []).findIndex((medium) => mediumTracks(medium).length > 0);
  const medium = mediumIndex >= 0 ? release.media![mediumIndex] : undefined;
  const releaseTrack = medium ? mediumTracks(medium)[0] : undefined;
  const albumArtist = artistCreditName(release["artist-credit"]) || artistCreditName(recording["artist-credit"]);
  const trackNumber = releaseTrack ? Number(releaseTrack.number ?? releaseTrack.position) || null : null;

  return {
    id: sha1([recording.id, release.id, medium?.position ?? "", trackNumber ?? ""].join(":")),
    score,
    acoustId: "",
    recordingId: recording.id,
    releaseId: release.id,
    releaseGroupId: release["release-group"]?.id ?? null,
    releaseTrackId: releaseTrack?.id,
    artist: artistCreditName(recording["artist-credit"]) || albumArtist,
    albumArtist,
    artistIds: artistCreditIds(recording["artist-credit"]),
    albumArtistIds: artistCreditIds(release["artist-credit"]),
    album: release.title,
    albumType: releaseGroupTypeLabel(release["release-group"]),
    title: releaseTrack?.title || recording.title,
    trackNumber,
    trackTotal: medium?.["track-count"] ?? null,
    discNumber: medium?.position ?? 1,
    discTotal: release.media?.length ?? null,
    year: releaseYear(release.date),
    originalYear: releaseYear(release["release-group"]?.["first-release-date"]),
    duration: recording.length ? Math.round(recording.length / 1000) : null,
    isrc: recording.isrcs?.[0]?.toUpperCase() ?? null
  };
}

/** Nudges the original studio release above compilations that happen to contain the same recording. */
function releasePreference(release: MbRelease) {
  const group = release["release-group"];
  const secondary = group?.["secondary-types"] ?? [];
  if (release.status && release.status !== "Official") return -0.08;
  if (secondary.includes("Compilation") || secondary.includes("DJ-mix")) return -0.06;
  if (secondary.length > 0) return -0.03;
  if (group?.["primary-type"] === "Album") return 0.06;
  if (group?.["primary-type"] === "EP" || group?.["primary-type"] === "Single") return 0.03;
  return 0;
}

/** Official studio albums first, then EPs and singles, then compilations; earliest date breaks ties. */
function rankReleasesForRecording(releases: MbRelease[]) {
  const rank = (release: MbRelease) => {
    const group = release["release-group"];
    const studio = (group?.["secondary-types"] ?? []).length === 0;
    const primary = group?.["primary-type"];
    let score = release.status === "Official" ? 0 : 10;
    score += studio ? 0 : 5;
    score += primary === "Album" ? 0 : primary === "EP" ? 1 : primary === "Single" ? 2 : 3;
    return score;
  };
  return [...releases].sort(
    (left, right) => rank(left) - rank(right) || (left.date || "9999").localeCompare(right.date || "9999")
  );
}

function dedupeCandidates(candidates: TrackIdentificationCandidate[]) {
  const unique = new Map<string, TrackIdentificationCandidate>();
  for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
    if (!unique.has(candidate.id)) {
      unique.set(candidate.id, candidate);
    }
  }
  return [...unique.values()];
}

function durationSimilarity(seconds: number | null | undefined, lengthMs: number | null | undefined) {
  if (!seconds || !lengthMs) {
    return 0.5;
  }
  const delta = Math.abs(seconds - lengthMs / 1000);
  return delta <= 2 ? 1 : delta >= 20 ? 0 : 1 - (delta - 2) / 18;
}

function usableHint(value: string | undefined | null) {
  const trimmed = value?.trim() ?? "";
  if (!trimmed || /^\[?unknown( artist| album| track)?\]?$/i.test(trimmed) || /^various artists$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function commonValue(values: Array<string | null>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}
