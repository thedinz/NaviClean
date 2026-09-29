import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type {
  TrackFile,
  TrackIdentificationCandidate,
  TrackIdentificationStatus,
  TrackMetadataSource,
  TrackMusicBrainzIds
} from "../shared/types.js";
import { isConfirmedIdentityStatus } from "../shared/identity.js";
import { httpCacheGet, httpCacheSet } from "./http-cache.js";
import { FingerprintCache, IdentityStore, type FingerprintResult, type StoredIdentity } from "./identity-store.js";
import { withIdentity } from "./identity.js";
import { identifyByMusicBrainzText } from "./mb-identify.js";
import { saveMetadataOverridesForTracks } from "./metadata-overrides.js";
import type { PrivateSettings } from "./settings.js";
import { isTrackKeepManaged } from "./trackkeep.js";
import { mapWithConcurrency, sha1 } from "./utils.js";

const execFileAsync = promisify(execFile);
const minimumAutomaticScore = 0.95;
const acoustIdResultLimit = 5;
const acoustIdMinimumSpacingMs = 350;
let acoustIdQueue: Promise<void> = Promise.resolve();
let lastAcoustIdRequestAt = 0;

type AcoustIdArtist = { id?: string; name?: string };
type AcoustIdTrack = {
  id?: string;
  position?: number;
  title?: string;
  artists?: AcoustIdArtist[];
  recording?: { id?: string };
};
type AcoustIdMedium = { position?: number; track_count?: number; tracks?: AcoustIdTrack[] };
type AcoustIdRelease = {
  id?: string;
  title?: string;
  date?: string | { year?: number; month?: number; day?: number } | null;
  artists?: AcoustIdArtist[];
  mediums?: AcoustIdMedium[];
  medium_count?: number;
};
type AcoustIdReleaseGroup = {
  id?: string;
  title?: string;
  type?: string;
  secondarytypes?: string[];
  artists?: AcoustIdArtist[];
  releases?: AcoustIdRelease[];
};
type AcoustIdRecording = {
  id?: string;
  title?: string;
  duration?: number;
  artists?: AcoustIdArtist[];
  isrcs?: string[];
  releases?: AcoustIdRelease[];
  releasegroups?: AcoustIdReleaseGroup[];
};
type AcoustIdResponse = {
  status?: string;
  error?: { code?: number; message?: string };
  results?: Array<{ id?: string; score?: number; recordings?: AcoustIdRecording[] }>;
};

export async function identifyTracks(
  settings: PrivateSettings,
  tracks: TrackFile[],
  onProgress?: (processedFiles: number) => void,
  signal?: AbortSignal,
  onPhase?: (phase: "searching", totalFiles: number) => void
) {
  const identification = settings.identification;
  if (!identification) {
    return { tracks, warnings: [] as string[] };
  }

  const warnings: string[] = [];
  const identities = IdentityStore.load();
  const fingerprintCache = new FingerprintCache();
  let fingerprintUnavailable = false;
  let lookupFailures = 0;
  let musicBrainzTagged = 0;

  const prepared = await mapWithConcurrency(tracks, 2, async (track) => {
    if (signal?.aborted) {
      return track;
    }

    const taggedIdentity = !isTrackKeepManaged(track.managedBy) &&
      track.metadataConfidence !== "spotify" &&
      track.metadataConfidence !== "trusted-path"
      ? musicBrainzTaggedIdentity(track)
      : null;

    if (taggedIdentity) {
      // Tier 1: Picard-style MusicBrainz tags already identify the recording and release.
      musicBrainzTagged += 1;
      return taggedIdentity;
    }

    const shouldFingerprint =
      isTrackKeepManaged(track.managedBy) ||
      track.metadataConfidence === "spotify" ||
      track.metadataConfidence === "trusted-path" ||
      identification.acoustIdEnabled;
    let fingerprint: FingerprintResult | null = null;

    if (shouldFingerprint) {
      try {
        fingerprint = await fingerprintTrack(track, fingerprintCache);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          fingerprintUnavailable = true;
        } else if (identification.acoustIdEnabled) {
          lookupFailures += 1;
        }
      }
    }

    if (isTrackKeepManaged(track.managedBy)) {
      const next = withIdentification(track, {
        status: "trackkeep-confirmed",
        source: "trackkeep",
        message: "TrackKeep identity tags are authoritative.",
        fingerprint: fingerprint?.fingerprint,
        spotifyTrackId: track.identification?.spotifyTrackId,
        spotifyAlbumId: track.identification?.spotifyAlbumId
      });
      if (fingerprint) {
        identities.set(fingerprint.fingerprint, storedIdentityFromTrack(next, fingerprint.fingerprint, "trackkeep"));
      }
      return next;
    }

    if (track.metadataConfidence === "spotify" || track.metadataConfidence === "trusted-path") {
      const source: TrackMetadataSource = track.metadataConfidence === "spotify" ? "spotify" : "local-path";
      const next = withIdentification(track, {
        status: "user-confirmed",
        source,
        message: track.metadataConfidence === "spotify"
          ? "Spotify metadata was explicitly selected by the user."
          : "This metadata was explicitly confirmed by the user.",
        fingerprint: fingerprint?.fingerprint
      });
      if (fingerprint) {
        identities.set(
          fingerprint.fingerprint,
          storedIdentityFromTrack(next, fingerprint.fingerprint, track.metadataConfidence)
        );
      }
      return next;
    }

    if (track.metadataConfidence === "musicbrainz" && track.identification?.status === "user-confirmed") {
      // A MusicBrainz release the user confirmed earlier, restored from the saved override.
      const next = withIdentification(track, { ...track.identification, fingerprint: fingerprint?.fingerprint });
      if (fingerprint) {
        identities.set(fingerprint.fingerprint, storedIdentityFromTrack(next, fingerprint.fingerprint, "musicbrainz"));
      }
      return next;
    }

    if (fingerprint) {
      const stored = identities.get(fingerprint.fingerprint);
      if (stored) {
        return trackFromStoredIdentity(track, stored, settings);
      }
    }

    if (!identification.acoustIdEnabled) {
      return localCandidateTrack(track, identification);
    }

    if (!identification.acoustIdApiKey) {
      lookupFailures += 1;
      return withIdentification(localCandidateTrack(track, identification), {
        status: "unidentified",
        source: "unknown",
        message: "AcoustID is enabled but its API key is missing.",
        fingerprint: fingerprint?.fingerprint
      });
    }

    if (!fingerprint) {
      return withIdentification(track, {
        status: "unidentified",
        source: "unknown",
        message: "The audio could not be fingerprinted; no metadata was trusted."
      });
    }

    try {
      const candidates = await cachedAcoustIdLookup(identification.acoustIdApiKey, fingerprint);
      if (candidates.length === 0) {
        return withIdentification(track, {
          status: "unidentified",
          source: "unknown",
          message: "No AcoustID/MusicBrainz match was found.",
          fingerprint: fingerprint.fingerprint
        });
      }
      return withIdentification(track, {
        status: candidates.some((candidate) => candidate.releaseId)
          ? "recording-identified-release-ambiguous"
          : "candidate-only",
        source: "musicbrainz",
        message: candidates.some((candidate) => candidate.releaseId)
          ? "The recording was identified; select or confirm the album release."
          : "The recording was identified, but no album release was available.",
        fingerprint: fingerprint.fingerprint,
        acoustId: candidates[0]?.acoustId,
        recordingId: uniqueValue(candidates.map((candidate) => candidate.recordingId)) ?? undefined,
        candidates,
        candidateSource: "acoustid"
      });
    } catch (error) {
      lookupFailures += 1;
      return withIdentification(track, {
        status: "unidentified",
        source: "unknown",
        message: error instanceof AcoustIdLookupError
          ? error.message
          : "AcoustID response could not be processed. Update NaviClean and run a new library scan; identity remains unconfirmed.",
        fingerprint: fingerprint.fingerprint
      });
    }
  }, onProgress);

  // Tier 2: text search for whatever the fingerprint tier could not place.
  const searched = await identifyByMusicBrainzText(settings, prepared, onProgress, signal, (total) => onPhase?.("searching", total));
  warnings.push(...searched.warnings);
  const resolved = resolveReleaseConsensus(searched.tracks, settings);
  identities.flush();
  fingerprintCache.flush();

  if (musicBrainzTagged > 0) {
    warnings.push(
      `Audio identification: ${musicBrainzTagged.toLocaleString()} tracks already carry MusicBrainz recording and release IDs and were trusted without a lookup.`
    );
  }
  if (fingerprintUnavailable) {
    warnings.push("Audio identification: fpcalc is unavailable. Install Chromaprint tools or use the Docker image.");
  }
  if (lookupFailures > 0) {
    warnings.push(`Audio identification: ${lookupFailures.toLocaleString()} fingerprint lookups could not be completed.`);
  }
  const reviewCount = resolved.filter((track) => identificationNeedsReview(track, settings)).length;
  if (reviewCount > 0) {
    warnings.push(`Audio identification: ${reviewCount.toLocaleString()} tracks require identity review before file changes.`);
  }

  return { tracks: resolved, warnings };
}

export function resolveReleaseConsensus(tracks: TrackFile[], settings: PrivateSettings) {
  const byFolder = new Map<string, TrackFile[]>();
  for (const track of tracks) {
    const folder = path.posix.dirname(track.relativePath.replace(/\\/g, "/"));
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), track]);
  }

  return tracks.map((track) => {
    if (track.identification?.status !== "recording-identified-release-ambiguous") {
      return track;
    }
    const candidates = (track.identification.candidates ?? []).filter(
      (candidate) => candidate.score >= minimumAutomaticScore && candidate.releaseId
    );
    const folder = path.posix.dirname(track.relativePath.replace(/\\/g, "/"));
    const peers = byFolder.get(folder) ?? [track];
    const commonReleaseIds = intersection(
      peers
        .filter((peer) => peer.identification?.source === "musicbrainz")
        .map((peer) => new Set(
          (peer.identification?.candidates ?? [])
            .filter((candidate) => candidate.score >= minimumAutomaticScore && candidate.releaseId)
            .map((candidate) => candidate.releaseId as string)
        ))
    );
    const releaseId = commonReleaseIds.size === 1
      ? Array.from(commonReleaseIds)[0]
      : uniqueValue(candidates.map((candidate) => candidate.releaseId).filter(Boolean) as string[]);
    const matching = candidates.filter((candidate) => candidate.releaseId === releaseId);

    if (!settings.identification?.autoAcceptUniqueFingerprintMatches || matching.length !== 1) {
      return track;
    }

    return applyCandidate(track, matching[0], settings, "fingerprint-and-release-confirmed");
  });
}

export async function confirmIdentificationCandidate(
  settings: PrivateSettings,
  tracks: TrackFile[],
  localTrackId: string,
  candidateId?: string
) {
  const track = tracks.find((item) => item.id === localTrackId);
  if (!track) {
    throw new Error("The local track is no longer in the current scan. Refresh and try again.");
  }
  if (isTrackKeepManaged(track.managedBy)) {
    throw new Error("TrackKeep identity is already authoritative.");
  }
  const candidate = candidateId
    ? track.identification?.candidates?.find((item) => item.id === candidateId)
    : track.identification?.candidates?.find((item) => item.releaseId === track.identification?.releaseId);
  if (!candidate) {
    throw new Error("The selected MusicBrainz candidate is no longer available. Run a new scan.");
  }

  const identities = IdentityStore.load();
  const selectedFolder = path.posix.dirname(track.relativePath.replace(/\\/g, "/"));
  const updatedTrackIds: string[] = [];
  const confirmedWithoutFingerprint: TrackFile[] = [];
  const nextTracks = tracks.map((item) => {
    const sameFolder = path.posix.dirname(item.relativePath.replace(/\\/g, "/")) === selectedFolder;
    const matchingCandidate = item.id === track.id
      ? candidate
      : sameFolder && candidate.releaseId
        ? item.identification?.candidates?.find((entry) => entry.releaseId === candidate.releaseId)
        : undefined;
    if (!matchingCandidate || isTrackKeepManaged(item.managedBy)) {
      return item;
    }
    const confirmed = applyCandidate(item, matchingCandidate, settings, "user-confirmed");
    const fingerprint = item.identification?.fingerprint;
    if (fingerprint) {
      identities.set(fingerprint, storedIdentityFromCandidate(matchingCandidate, fingerprint, "musicbrainz"));
    } else {
      // Text-search matches may have no fingerprint; remember them by path and size instead.
      confirmedWithoutFingerprint.push(confirmed);
    }
    updatedTrackIds.push(item.id);
    return confirmed;
  });
  identities.flush();
  if (confirmedWithoutFingerprint.length > 0) {
    await saveMetadataOverridesForTracks(confirmedWithoutFingerprint, "musicbrainz");
  }
  return {
    tracks: nextTracks,
    updatedTrackIds
  };
}

export async function rememberConfirmedTrackIdentities(tracks: TrackFile[], source: "spotify" | "trusted-path") {
  const identities = IdentityStore.load();
  const cache = new FingerprintCache();
  for (const track of tracks) {
    try {
      const fingerprint = await fingerprintTrack(track, cache);
      identities.set(fingerprint.fingerprint, storedIdentityFromTrack(track, fingerprint.fingerprint, source));
    } catch {
      // Path-based overrides remain available when the optional fingerprint tool cannot read a file.
    }
  }
  identities.flush();
  cache.flush();
}

export function identificationNeedsReview(track: TrackFile, settings: PrivateSettings) {
  const status = track.identification?.status;
  if (!settings.identification || !status || isTrackKeepManaged(track.managedBy)) {
    return false;
  }
  if (isConfirmedIdentityStatus(status)) {
    return false;
  }
  if (status === "fingerprint-and-release-confirmed") {
    return settings.identification.requireReviewBeforeFileChanges;
  }
  return true;
}

/** Tier 1: a file tagged with both a MusicBrainz recording and release ID is trusted as-is. */
function musicBrainzTaggedIdentity(track: TrackFile): TrackFile | null {
  const ids = track.musicbrainz;
  if (!ids?.recordingId || !ids.releaseId) {
    return null;
  }

  return {
    ...track,
    metadataConfidence: "musicbrainz",
    targetSource: "musicbrainz",
    identification: {
      status: "musicbrainz-tagged",
      source: "musicbrainz",
      message: "MusicBrainz recording and release IDs in the file's tags are trusted.",
      recordingId: ids.recordingId,
      releaseId: ids.releaseId,
      releaseGroupId: ids.releaseGroupId
    }
  };
}

const acoustIdCacheTtlMs = 1000 * 60 * 60 * 24 * 30;
const acoustIdEmptyCacheTtlMs = 1000 * 60 * 60 * 24 * 7;

/** AcoustID answers are stable, so scans reuse them instead of re-querying unconfirmed tracks every time. */
export async function cachedAcoustIdLookup(apiKey: string, fingerprint: FingerprintResult) {
  const key = `acoustid:${sha1(`${fingerprint.duration}:${fingerprint.fingerprint}`)}`;
  const cached = httpCacheGet<TrackIdentificationCandidate[]>(key);
  if (cached) {
    return cached;
  }

  const candidates = await lookupAcoustId(apiKey, fingerprint);
  httpCacheSet(key, candidates, candidates.length > 0 ? acoustIdCacheTtlMs : acoustIdEmptyCacheTtlMs);
  return candidates;
}

function localCandidateTrack(track: TrackFile, settings: NonNullable<PrivateSettings["identification"]>) {
  const source: TrackMetadataSource = settings.useEmbeddedTagsAsHints
    ? "local-tags"
    : settings.usePathAsHints
      ? "local-path"
      : "unknown";
  return withIdentification(track, {
    status: source === "unknown" ? "unidentified" : "candidate-only",
    source,
    message: source === "unknown"
      ? "No trusted identity is available. Local tags and paths are disabled as hints."
      : "Local tags and paths are search hints only and require identification."
  });
}

function applyCandidate(
  track: TrackFile,
  candidate: TrackIdentificationCandidate,
  settings: PrivateSettings,
  status: TrackIdentificationStatus
): TrackFile {
  return withIdentity(track, settings, {
    artist: candidate.artist || candidate.albumArtist,
    albumArtist: candidate.albumArtist || candidate.artist,
    album: candidate.album,
    albumType: candidate.albumType || "Album",
    title: candidate.title,
    trackNumber: candidate.trackNumber,
    trackTotal: candidate.trackTotal,
    discNumber: candidate.discNumber,
    discTotal: candidate.discTotal,
    year: candidate.year,
    duration: track.duration ?? candidate.duration,
    isrc: candidate.isrc ?? track.isrc ?? null,
    metadataConfidence: "musicbrainz",
    targetSource: "musicbrainz",
    musicbrainz: musicBrainzIdsFromCandidate(candidate, track.musicbrainz),
    identification: {
      status,
      source: "musicbrainz",
      message: status === "user-confirmed"
        ? "MusicBrainz release selected by the user."
        : "A unique acoustic fingerprint and album release match was found.",
      fingerprint: track.identification?.fingerprint,
      acoustId: candidate.acoustId,
      recordingId: candidate.recordingId,
      releaseId: candidate.releaseId ?? undefined,
      releaseGroupId: candidate.releaseGroupId ?? undefined,
      candidates: track.identification?.candidates,
      candidateSource: track.identification?.candidateSource
    }
  });
}

function musicBrainzIdsFromCandidate(
  candidate: TrackIdentificationCandidate,
  existing: TrackMusicBrainzIds | undefined
): TrackMusicBrainzIds | undefined {
  if (!candidate.recordingId && !candidate.releaseId) {
    return existing;
  }
  // A different release invalidates the old release-level IDs; keep nothing from it.
  const sameRelease = existing?.releaseId && existing.releaseId === candidate.releaseId;
  return {
    recordingId: candidate.recordingId || undefined,
    releaseId: candidate.releaseId ?? undefined,
    releaseGroupId: candidate.releaseGroupId ?? (sameRelease ? existing?.releaseGroupId : undefined),
    releaseTrackId: candidate.releaseTrackId ?? (sameRelease ? existing?.releaseTrackId : undefined),
    artistIds: candidate.artistIds?.length ? candidate.artistIds : sameRelease ? existing?.artistIds : undefined,
    albumArtistIds: candidate.albumArtistIds?.length ? candidate.albumArtistIds : sameRelease ? existing?.albumArtistIds : undefined
  };
}

function trackFromStoredIdentity(track: TrackFile, stored: StoredIdentity, settings: PrivateSettings) {
  const status = stored.source === "trackkeep" ? "trackkeep-confirmed" as const : "user-confirmed" as const;
  const source: TrackMetadataSource = stored.source === "trackkeep"
    ? "trackkeep"
    : stored.source === "spotify"
      ? "spotify"
      : stored.source === "trusted-path"
        ? "local-path"
        : "musicbrainz";
  const identified = applyCandidate(track, stored.candidate, settings, status);
  return {
    ...identified,
    managedBy: stored.source === "trackkeep" ? "trackkeep" as const : identified.managedBy,
    metadataConfidence: stored.source === "spotify" ? "spotify" as const : identified.metadataConfidence,
    targetSource: stored.source === "spotify" ? "spotify" as const : identified.targetSource,
    identification: {
      ...identified.identification!,
      source,
      message: "Restored a previously confirmed identity from the audio fingerprint.",
      spotifyTrackId: stored.spotifyTrackId,
      spotifyAlbumId: stored.spotifyAlbumId
    }
  };
}

function storedIdentityFromTrack(
  track: TrackFile,
  fingerprint: string,
  source: StoredIdentity["source"]
): StoredIdentity {
  const candidate: TrackIdentificationCandidate = {
    id: sha1(`${source}:${track.id}:${track.title}`),
    score: 1,
    acoustId: track.identification?.acoustId ?? "",
    recordingId: track.identification?.recordingId ?? track.musicbrainz?.recordingId ?? "",
    releaseId: track.identification?.releaseId ?? track.musicbrainz?.releaseId ?? null,
    releaseGroupId: track.identification?.releaseGroupId ?? track.musicbrainz?.releaseGroupId ?? null,
    releaseTrackId: track.musicbrainz?.releaseTrackId,
    artistIds: track.musicbrainz?.artistIds,
    albumArtistIds: track.musicbrainz?.albumArtistIds,
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
    duration: track.duration,
    isrc: track.isrc ?? null
  };
  return {
    fingerprint,
    source,
    candidate,
    spotifyTrackId: track.identification?.spotifyTrackId,
    spotifyAlbumId: track.identification?.spotifyAlbumId,
    confirmedAt: new Date().toISOString()
  };
}

function storedIdentityFromCandidate(
  candidate: TrackIdentificationCandidate,
  fingerprint: string,
  source: StoredIdentity["source"]
): StoredIdentity {
  return { fingerprint, source, candidate, confirmedAt: new Date().toISOString() };
}

async function fingerprintTrack(track: TrackFile, cache: FingerprintCache) {
  const cached = cache.lookup(track);
  if (cached) {
    return cached;
  }
  const result = await fingerprintFile(track.absolutePath);
  cache.store(track, result);
  return result;
}

export async function fingerprintFile(filePath: string): Promise<FingerprintResult> {
  const { stdout } = await execFileAsync("fpcalc", ["-json", filePath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000
  });
  const parsed = JSON.parse(stdout) as Partial<FingerprintResult>;
  if (!parsed.fingerprint || !Number.isFinite(parsed.duration) || Number(parsed.duration) <= 0) {
    throw new Error("fpcalc did not return a usable fingerprint");
  }
  return { duration: Math.round(Number(parsed.duration)), fingerprint: parsed.fingerprint };
}

class AcoustIdLookupError extends Error {}

export async function lookupAcoustId(apiKey: string, fingerprint: FingerprintResult) {
  const body = new URLSearchParams({
    client: apiKey,
    duration: String(fingerprint.duration),
    fingerprint: fingerprint.fingerprint,
    format: "json",
    meta: "recordings releases releasegroups tracks isrcs"
  });
  return queuedAcoustIdRequest(async () => {
    const response = await fetch("https://api.acoustid.org/v2/lookup", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "NaviClean/0.6" },
      body,
      signal: AbortSignal.timeout(30_000)
    }).catch(() => {
      throw new AcoustIdLookupError("AcoustID could not be reached or timed out. Check the server's network connection and retry the library scan; identity remains unconfirmed.");
    });
    const payload = await response.json().catch(() => null) as AcoustIdResponse | null;
    if (payload?.error?.code === 4) {
      throw new AcoustIdLookupError("AcoustID rejected the application API key. Check Settings → Audio identification. Identity remains unconfirmed.");
    }
    if (!response.ok) {
      throw new AcoustIdLookupError(`AcoustID returned HTTP ${response.status}. ${response.status === 429 ? "Rate limit reached; retry the library scan later." : "Check AcoustID availability and your application API key, then retry the library scan."} Identity remains unconfirmed.`);
    }
    if (!payload) {
      throw new AcoustIdLookupError("AcoustID returned an invalid response. Retry the library scan later; identity remains unconfirmed.");
    }
    if (payload.status !== "ok") {
      // Use controlled messages rather than exposing an upstream response or credentials.
      const reason = `AcoustID rejected the lookup${typeof payload.error?.code === "number" ? ` (error ${payload.error.code})` : ""}. Check the application API key and retry the library scan.`;
      throw new AcoustIdLookupError(`${reason} Identity remains unconfirmed.`);
    }
    return candidatesFromAcoustId(payload);
  });
}

async function queuedAcoustIdRequest<T>(operation: () => Promise<T>) {
  let resolveResult!: (value: T | PromiseLike<T>) => void;
  let rejectResult!: (reason?: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  acoustIdQueue = acoustIdQueue.then(async () => {
    const waitMs = Math.max(0, acoustIdMinimumSpacingMs - (Date.now() - lastAcoustIdRequestAt));
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    lastAcoustIdRequestAt = Date.now();
    try {
      resolveResult(await operation());
    } catch (error) {
      rejectResult(error);
    }
  });
  await acoustIdQueue;
  return result;
}

export function candidatesFromAcoustId(payload: AcoustIdResponse): TrackIdentificationCandidate[] {
  const candidates: TrackIdentificationCandidate[] = [];
  for (const result of payload.results ?? []) {
    const score = Number(result.score ?? 0);
    const acoustId = result.id ?? "";
    for (const recording of result.recordings ?? []) {
      const recordingId = recording.id ?? "";
      if (!recordingId || !recording.title) {
        continue;
      }
      const releaseGroups = recording.releasegroups?.length
        ? recording.releasegroups
        : [{ releases: recording.releases }] as AcoustIdReleaseGroup[];
      for (const releaseGroup of releaseGroups) {
        const releases = releaseGroup.releases?.length ? releaseGroup.releases : [undefined];
        for (const release of releases) {
          const slot = release ? recordingSlot(release, recordingId) : null;
          const recordingArtists = artistCredit(recording.artists);
          const albumArtists = artistCredit(release?.artists) || artistCredit(releaseGroup.artists) || recordingArtists;
          const candidate: TrackIdentificationCandidate = {
            id: sha1([recordingId, release?.id ?? "", slot?.discNumber ?? "", slot?.trackNumber ?? ""].join(":")),
            score,
            acoustId,
            recordingId,
            releaseId: release?.id ?? null,
            releaseGroupId: releaseGroup.id ?? null,
            artist: slot?.artist || recordingArtists || albumArtists,
            albumArtist: albumArtists || recordingArtists,
            album: release?.title || releaseGroup.title || "Unknown Album",
            albumType: releaseGroup.secondarytypes?.[0] || releaseGroup.type || "Album",
            title: slot?.title || recording.title,
            trackNumber: slot?.trackNumber ?? null,
            trackTotal: slot?.trackTotal ?? null,
            discNumber: slot?.discNumber ?? null,
            discTotal: release?.medium_count ?? release?.mediums?.length ?? null,
            year: releaseYear(release?.date),
            duration: recording.duration ? Math.round(recording.duration) : null,
            isrc: recording.isrcs?.[0]?.toUpperCase() ?? null
          };
          const releaseTrackId = slot?.releaseTrackId;
          const artistIds = artistCreditIds(slot?.artistRefs ?? recording.artists);
          const albumArtistIds = artistCreditIds(release?.artists ?? releaseGroup.artists);
          if (releaseTrackId) candidate.releaseTrackId = releaseTrackId;
          if (artistIds.length) candidate.artistIds = artistIds;
          if (albumArtistIds.length) candidate.albumArtistIds = albumArtistIds;
          candidates.push(candidate);
        }
      }
    }
  }
  const unique = new Map<string, TrackIdentificationCandidate>();
  for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
    if (!unique.has(candidate.id)) {
      unique.set(candidate.id, candidate);
    }
  }
  return Array.from(unique.values()).slice(0, acoustIdResultLimit * 4);
}

function recordingSlot(release: AcoustIdRelease, recordingId: string) {
  for (const medium of release.mediums ?? []) {
    for (const track of medium.tracks ?? []) {
      if (track.recording?.id && track.recording.id !== recordingId) {
        continue;
      }
      return {
        artist: artistCredit(track.artists),
        artistRefs: track.artists,
        releaseTrackId: track.id,
        title: track.title,
        trackNumber: positiveInteger(track.position),
        trackTotal: positiveInteger(medium.track_count) ?? medium.tracks?.length ?? null,
        discNumber: positiveInteger(medium.position) ?? 1
      };
    }
  }
  return null;
}

function artistCredit(artists: AcoustIdArtist[] | undefined) {
  return (artists ?? []).map((artist) => artist.name?.trim()).filter(Boolean).join(", ");
}

function artistCreditIds(artists: AcoustIdArtist[] | undefined) {
  return (artists ?? []).map((artist) => artist.id?.trim()).filter((id): id is string => Boolean(id));
}

function releaseYear(value: AcoustIdRelease["date"]) {
  // AcoustID returns a structured date, which may omit the year.
  // Keep support for string dates in older saved responses and fixtures.
  if (typeof value === "string") {
    const year = value.match(/^\d{4}/)?.[0];
    return year ? positiveInteger(year) : null;
  }
  return value && typeof value === "object" ? positiveInteger(value.year) : null;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function intersection(sets: Set<string>[]) {
  if (sets.length === 0) {
    return new Set<string>();
  }
  return sets.slice(1).reduce(
    (current, set) => new Set(Array.from(current).filter((value) => set.has(value))),
    new Set(sets[0])
  );
}

function uniqueValue(values: string[]) {
  const unique = Array.from(new Set(values.filter(Boolean)));
  return unique.length === 1 ? unique[0] : null;
}

function withIdentification(track: TrackFile, identification: NonNullable<TrackFile["identification"]>): TrackFile {
  return { ...track, identification };
}
