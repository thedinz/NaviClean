import type { DownloadAttempt, DownloadTrack, DownloadVerification, QualityCodecFamily } from "../../shared/types.js";
import { cachedAcoustIdLookup, fingerprintFile } from "../identification.js";
import { textSimilarity } from "../musicbrainz.js";
import { probeStagedAudioEncoding } from "../providers.js";
import { engineSettings, qualitySettings, type PrivateSettings } from "../settings.js";

export type VerificationResult =
  | { ok: true; verification: DownloadVerification }
  | { ok: false; reason: DownloadAttempt["reason"]; message: string; verification: DownloadVerification };

/**
 * Checks a staged download before it may enter the library: source quality floor,
 * duration against the requested recording, and (when AcoustID is configured) that the
 * audio fingerprint resolves to the same song.
 */
export async function verifyStagedDownload(
  settings: PrivateSettings,
  track: DownloadTrack,
  stagedPath: string,
  source: { codec: string | null; bitrateKbps: number | null } = { codec: null, bitrateKbps: null }
): Promise<VerificationResult> {
  const engine = engineSettings(settings);
  const quality = qualitySettings(settings);
  const verification: DownloadVerification = {
    durationDeltaSeconds: null,
    sourceBitrateKbps: null,
    sourceCodec: null,
    fingerprint: "skipped",
    acoustIdScore: null,
    notes: []
  };

  const encoding = await probeStagedAudioEncoding(stagedPath).catch(() => null);
  // Prefer what yt-dlp reported about the original stream; the staged file may be a re-encode.
  verification.sourceCodec = source.codec ?? (encoding?.codecName || null);
  verification.sourceBitrateKbps = source.bitrateKbps ?? (encoding?.bitRate ? Math.round(encoding.bitRate / 1000) : null);
  if (!encoding) {
    verification.notes.push("ffprobe could not read the downloaded stream.");
  }

  const family = codecFamily(verification.sourceCodec);
  const floor = quality.minimumBitrateKbps[family];
  if (verification.sourceBitrateKbps !== null && floor > 0 && verification.sourceBitrateKbps < floor) {
    return fail(
      "low-quality",
      `The source is ${verification.sourceBitrateKbps} kbps ${family}, below the ${floor} kbps floor set in Settings.`,
      verification
    );
  }

  const expectedSeconds = track.durationMs > 0 ? track.durationMs / 1000 : null;
  if (engine.verifyDuration && expectedSeconds && encoding?.durationSeconds) {
    const delta = Math.abs(encoding.durationSeconds - expectedSeconds);
    verification.durationDeltaSeconds = Math.round(delta * 10) / 10;
    const tolerance = durationToleranceSeconds(expectedSeconds);
    if (delta > tolerance) {
      return fail(
        "duration-mismatch",
        `The download runs ${formatSeconds(encoding.durationSeconds)} but the release track is ${formatSeconds(expectedSeconds)} (allowed difference ${Math.round(tolerance)} s).`,
        verification
      );
    }
  }

  const identification = settings.identification;
  if (engine.verifyFingerprint && identification?.acoustIdEnabled && identification.acoustIdApiKey) {
    const outcome = await fingerprintMatches(identification.acoustIdApiKey, track, stagedPath, verification);
    if (outcome) {
      return outcome;
    }
  } else if (engine.verifyFingerprint) {
    verification.notes.push("Fingerprint check skipped: enable AcoustID in Settings to verify downloads by audio.");
  }

  return { ok: true, verification };
}

/** Allowed length difference: YouTube uploads often add a second or two of silence. */
export function durationToleranceSeconds(expectedSeconds: number) {
  return Math.max(7, expectedSeconds * 0.04);
}

export function codecFamily(codec: string | null): QualityCodecFamily {
  const value = (codec ?? "").toLowerCase();
  if (value.includes("opus")) return "opus";
  if (value.includes("vorbis")) return "vorbis";
  if (value.includes("aac") || value.includes("mp4a")) return "aac";
  if (value.includes("mp3") || value === "mpeg 1 layer 3") return "mp3";
  return "other";
}

async function fingerprintMatches(
  apiKey: string,
  track: DownloadTrack,
  stagedPath: string,
  verification: DownloadVerification
): Promise<VerificationResult | null> {
  let candidates;
  try {
    const fingerprint = await fingerprintFile(stagedPath);
    candidates = await cachedAcoustIdLookup(apiKey, fingerprint);
  } catch (error) {
    verification.fingerprint = "inconclusive";
    verification.notes.push(`Fingerprint check could not complete: ${(error as Error).message}`);
    return null;
  }

  if (candidates.length === 0) {
    verification.fingerprint = "inconclusive";
    verification.notes.push("AcoustID does not know this audio yet, so it could not be cross-checked.");
    return null;
  }

  verification.acoustIdScore = Math.max(...candidates.map((candidate) => candidate.score));
  const expectedRecording = track.musicbrainz?.recordingId;
  const artist = track.artists.join(" ") || track.albumArtist;

  if (expectedRecording && candidates.some((candidate) => candidate.recordingId === expectedRecording)) {
    verification.fingerprint = "match";
    return null;
  }

  if (track.isrc && candidates.some((candidate) => candidate.isrc === track.isrc)) {
    verification.fingerprint = "match";
    verification.notes.push("Matched by ISRC.");
    return null;
  }

  const sameSong = candidates.some(
    (candidate) => textSimilarity(track.title, candidate.title) >= 0.8 && textSimilarity(artist, candidate.artist || candidate.albumArtist) >= 0.5
  );
  if (sameSong) {
    verification.fingerprint = "match";
    if (expectedRecording) {
      // Remasters and reissues get their own MusicBrainz recordings; the song is still right.
      verification.notes.push("Fingerprint matched the same song under a different MusicBrainz recording.");
    }
    return null;
  }

  verification.fingerprint = "mismatch";
  const heard = candidates[0];
  return fail(
    "fingerprint-mismatch",
    `The audio fingerprints as "${heard.title}" by ${heard.artist || heard.albumArtist || "an unknown artist"}, not the requested track.`,
    verification
  );
}

function fail(reason: DownloadAttempt["reason"], message: string, verification: DownloadVerification): VerificationResult {
  return { ok: false, reason, message, verification };
}

function formatSeconds(value: number) {
  const total = Math.round(value);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
