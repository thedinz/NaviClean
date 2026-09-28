import fs from "node:fs/promises";
import path from "node:path";
import type {
  CatalogProviderCandidate,
  DownloadAttempt,
  DownloadItemStatus,
  DownloadJob,
  DownloadJobItem,
  DownloadJobStatus,
  DownloadJobSummary,
  DownloadReviewItem,
  DownloadTrack,
  TrackFile
} from "../../shared/types.js";
import { loadCatalog, saveCatalog, upsertCatalogTracks } from "../catalog.js";
import { execute, parseJson, queryAll } from "../db.js";
import { publish } from "../events.js";
import { trashLibraryTracks } from "../library.js";
import {
  createDownloadStagingDirectory,
  nextAvailableFilePath,
  normalizeStagedAudioFile,
  providerDownloadProfile,
  providerForUrl,
  recordDownloadProvenance,
  withProviderFormatFallback,
  type ProviderDownloadFormat
} from "../providers.js";
import { engineSettings, type PrivateSettings } from "../settings.js";
import { sha1, toPosixRelative } from "../utils.js";
import { LibraryPresence } from "./presence.js";
import { quarantineCandidate, quarantinedCandidateIds } from "./quarantine.js";
import { candidateFromUrl, sourceById, type FetchedAudio } from "./sources.js";
import { downloadTrackToTrackFile, tagStagedDownload } from "./tagging.js";
import { verifyStagedDownload, type VerificationResult } from "./verify.js";
import { recordWanted, resolveWanted } from "./wanted.js";

export type NewDownloadJob = {
  title: string;
  subtitle: string;
  origin: DownloadJob["origin"];
  catalog: DownloadJob["catalog"];
  coverUrl: string | null;
  tracks: DownloadTrack[];
  /** Library track IDs to replace, keyed by DownloadTrack.key (quality upgrades). */
  replaceTrackIds?: Record<string, string>;
  /** Skip tracks already in the library (default true). */
  skipPresent?: boolean;
};

type SettingsLoader = () => Promise<PrivateSettings>;

const maxCandidatesKept = 10;
const maxAutomaticAttempts = 3;
const searchResultLimit = 6;
const activeStatuses = new Set<DownloadItemStatus>(["searching", "downloading", "verifying"]);
const terminalItemStatuses = new Set<DownloadItemStatus>(["completed", "skipped", "failed", "cancelled"]);
const terminalJobStatuses = new Set<DownloadJobStatus>(["completed", "partial", "failed", "cancelled"]);
const finishedJobRetention = 200;

const jobs = new Map<string, DownloadJob>();
const inFlight = new Set<string>();
let loadSettings: SettingsLoader | null = null;
let pumping = false;
let initialized = false;

class VerificationFailure extends Error {
  constructor(readonly result: Extract<VerificationResult, { ok: false }>) {
    super(result.message);
  }
}

/** Loads saved jobs, resumes anything interrupted by a restart, and starts the queue. */
export function initializeDownloadEngine(settingsLoader: SettingsLoader) {
  loadSettings = settingsLoader;
  if (initialized) {
    return;
  }
  initialized = true;

  for (const row of queryAll<{ data: string }>("SELECT data FROM download_jobs ORDER BY created_at")) {
    const job = parseJson<DownloadJob>(row.data);
    if (!job?.id) {
      continue;
    }
    for (const item of job.items) {
      if (activeStatuses.has(item.status)) {
        // Interrupted work restarts: a reviewer's approval is kept, automatic picks search again.
        if (item.approvedByUser && item.selectedCandidateId) {
          item.status = "downloading";
        } else {
          item.status = "pending";
          item.selectedCandidateId = undefined;
        }
        item.message = "Resumed after NaviClean restarted.";
      }
    }
    refreshJob(job);
    jobs.set(job.id, job);
  }

  void pump();
}

export async function createDownloadJob(request: NewDownloadJob) {
  const settings = await requireSettings();
  const now = new Date().toISOString();
  const catalog = await loadCatalog();
  const presence = new LibraryPresence(catalog.tracks);
  const queuedKeys = activeTrackKeys();
  const skipPresent = request.skipPresent !== false;

  const job: DownloadJob = {
    id: `dl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: request.title,
    subtitle: request.subtitle,
    origin: request.origin,
    catalog: request.catalog,
    coverUrl: request.coverUrl,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    counts: emptyCounts(),
    items: request.tracks.map((track, index) => {
      const replaceTrackId = request.replaceTrackIds?.[track.key];
      const present = skipPresent && !replaceTrackId ? presence.find(track) : null;
      const alreadyQueued = !replaceTrackId && queuedKeys.has(track.key);
      const planned = downloadTrackToTrackFile(settings, track, "opus");
      return {
        id: sha1(`${now}:${index}:${track.key}`).slice(0, 16),
        track,
        status: present || alreadyQueued ? "skipped" : "pending",
        message: present
          ? `Already in your library: ${present.relativePath}`
          : alreadyQueued
            ? "Already queued in another download."
            : undefined,
        candidates: [],
        attempts: [],
        targetRelativePath: planned.targetRelativePath,
        replaceTrackId
      } satisfies DownloadJobItem;
    })
  };

  refreshJob(job);
  jobs.set(job.id, job);
  saveJob(job);
  publishJob(job);
  void pump();
  return job;
}

export function listDownloadJobs(): DownloadJobSummary[] {
  return [...jobs.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(summary);
}

export function getDownloadJob(jobId: string) {
  return jobs.get(jobId) ?? null;
}

export function listReviewItems(): DownloadReviewItem[] {
  return [...jobs.values()].flatMap((job) =>
    job.items.filter((item) => item.status === "review").map((item) => ({ jobId: job.id, jobTitle: job.title, item }))
  );
}

export function activeJobCount() {
  return [...jobs.values()].filter((job) => !terminalJobStatuses.has(job.status) && job.status !== "review").length;
}

export function cancelDownloadJob(jobId: string) {
  const job = requireJob(jobId);
  for (const item of job.items) {
    if (!terminalItemStatuses.has(item.status) && !inFlight.has(item.id)) {
      item.status = "cancelled";
      item.message = "Cancelled.";
    }
  }
  job.status = "cancelled";
  touch(job);
  return job;
}

/** Re-queues failed and cancelled items of a job. */
export function retryDownloadJob(jobId: string) {
  const job = requireJob(jobId);
  for (const item of job.items) {
    if (item.status === "failed" || item.status === "cancelled") {
      item.status = "pending";
      item.error = undefined;
      item.message = "Queued for another attempt.";
      item.selectedCandidateId = undefined;
    }
  }
  job.status = "queued";
  touch(job);
  void pump();
  return job;
}

export function removeDownloadJob(jobId: string) {
  const job = requireJob(jobId);
  if (job.items.some((item) => inFlight.has(item.id))) {
    throw new Error("This download is still running. Cancel it and wait for the current track to finish.");
  }
  jobs.delete(jobId);
  execute("DELETE FROM download_jobs WHERE id = ?", jobId);
}

export function clearFinishedJobs() {
  for (const job of [...jobs.values()]) {
    if (terminalJobStatuses.has(job.status)) {
      jobs.delete(job.id);
      execute("DELETE FROM download_jobs WHERE id = ?", job.id);
    }
  }
}

/** Accepts a held candidate (or a pasted link) and sends the item on to download and verify. */
export function approveReviewItem(jobId: string, itemId: string, choice: { candidateId?: string; url?: string }) {
  const job = requireJob(jobId);
  const item = requireItem(job, itemId);
  if (item.status !== "review") {
    throw new Error("This track is no longer waiting for review.");
  }

  let candidate: CatalogProviderCandidate | undefined;
  if (choice.url) {
    candidate = candidateFromUrl(item.track, providerForUrl(choice.url), choice.url);
    item.candidates = [candidate, ...item.candidates.filter((entry) => entry.id !== candidate!.id)].slice(0, maxCandidatesKept);
  } else {
    candidate = item.candidates.find((entry) => entry.id === (choice.candidateId ?? item.candidates[0]?.id));
  }
  if (!candidate) {
    throw new Error("That candidate is no longer available. Search again.");
  }

  item.selectedCandidateId = candidate.id;
  item.approvedByUser = true;
  item.status = "downloading";
  item.message = "Approved; downloading.";
  item.error = undefined;
  if (terminalJobStatuses.has(job.status)) {
    job.status = "running";
  }
  touch(job);
  void pump();
  return job;
}

/** Declines the held candidates; the track either waits in Wanted or is dropped. */
export function rejectReviewItem(jobId: string, itemId: string, options: { keepWanted: boolean }) {
  const job = requireJob(jobId);
  const item = requireItem(job, itemId);
  if (item.status !== "review") {
    throw new Error("This track is no longer waiting for review.");
  }

  item.status = options.keepWanted ? "failed" : "skipped";
  item.message = options.keepWanted ? "Rejected; added to Wanted for a later search." : "Rejected during review.";
  if (options.keepWanted) {
    recordWanted(item.track, "Rejected during review", "No acceptable candidate was approved.");
  }
  touch(job);
  return job;
}

/** Searches again for an item, e.g. from the review queue after candidates went stale. */
export function researchItem(jobId: string, itemId: string) {
  const job = requireJob(jobId);
  const item = requireItem(job, itemId);
  if (inFlight.has(item.id)) {
    throw new Error("This track is already being processed.");
  }
  item.status = "pending";
  item.selectedCandidateId = undefined;
  item.candidates = [];
  item.message = "Searching again.";
  job.status = "queued";
  touch(job);
  void pump();
  return job;
}

function activeTrackKeys() {
  const keys = new Set<string>();
  for (const job of jobs.values()) {
    for (const item of job.items) {
      if (!terminalItemStatuses.has(item.status)) {
        keys.add(item.track.key);
      }
    }
  }
  return keys;
}

async function pump() {
  if (pumping || !loadSettings) {
    return;
  }
  pumping = true;

  try {
    while (true) {
      const settings = await loadSettings();
      const concurrency = settings.catalog.providers.maxConcurrentDownloads;
      if (inFlight.size >= concurrency) {
        break;
      }
      const next = nextRunnableItem();
      if (!next) {
        break;
      }
      inFlight.add(next.item.id);
      void processItem(next.job, next.item)
        .catch((error) => {
          next.item.status = "failed";
          next.item.error = (error as Error).message;
          touch(next.job);
        })
        .finally(() => {
          inFlight.delete(next.item.id);
          void pump();
        });
    }
  } finally {
    pumping = false;
  }
}

function nextRunnableItem() {
  const ordered = [...jobs.values()]
    .filter((job) => job.status !== "cancelled")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const job of ordered) {
    for (const item of job.items) {
      if (inFlight.has(item.id)) {
        continue;
      }
      if (item.status === "pending" || (item.status === "downloading" && item.selectedCandidateId)) {
        return { job, item };
      }
    }
  }
  return null;
}

async function processItem(job: DownloadJob, item: DownloadJobItem) {
  const settings = await requireSettings();
  const engine = engineSettings(settings);
  item.startedAt ??= new Date().toISOString();

  if (!item.selectedCandidateId) {
    item.status = "searching";
    item.message = "Searching sources.";
    touch(job);

    try {
      item.candidates = await searchCandidates(settings, item.track);
    } catch (error) {
      failItem(job, item, `Search failed: ${(error as Error).message}`, true);
      return;
    }
  }

  const manual = Boolean(item.selectedCandidateId);

  while (true) {
    if (job.status === "cancelled") {
      item.status = "cancelled";
      item.message = "Cancelled.";
      touch(job);
      return;
    }

    const tried = new Set(item.attempts.map((attempt) => attempt.candidateId));
    const candidate = manual
      ? item.candidates.find((entry) => entry.id === item.selectedCandidateId)
      : item.candidates.find((entry) => !tried.has(entry.id) && entry.score.overall >= engine.autoAcceptScore);

    if (!candidate) {
      const best = item.candidates.find((entry) => !tried.has(entry.id));
      if (best && best.score.overall >= engine.reviewScore) {
        item.status = "review";
        item.message = `Best match scored ${best.score.overall}; below the ${engine.autoAcceptScore} needed to download automatically. Review it.`;
        if (job.origin === "wanted") {
          // Keep the Wanted entry moving; it is retried later unless the review resolves it first.
          recordWanted(item.track, "Held for review", item.message);
        }
        touch(job);
        return;
      }
      const reason = best
        ? `No confident match: the best result scored ${best.score.overall} (review needs ${engine.reviewScore}).`
        : item.candidates.length
          ? "Every candidate failed verification."
          : "No source had a matching result.";
      failItem(job, item, reason, true);
      return;
    }

    item.selectedCandidateId = candidate.id;
    const outcome = await acquireCandidate(settings, job, item, candidate);
    if (outcome === "done") {
      return;
    }

    if (manual) {
      // The reviewer's choice failed verification; hand the decision back to them.
      item.selectedCandidateId = undefined;
      item.approvedByUser = false;
      item.status = "review";
      item.message = `The approved source failed: ${item.error ?? "verification failed"}. Choose another.`;
      touch(job);
      return;
    }

    item.selectedCandidateId = undefined;
    if (item.attempts.length >= maxAutomaticAttempts) {
      failItem(job, item, `Tried ${item.attempts.length} sources and none passed verification.`, true);
      return;
    }
  }
}

async function searchCandidates(settings: PrivateSettings, track: DownloadTrack) {
  const engine = engineSettings(settings);
  const quarantined = quarantinedCandidateIds(track.key);
  const enabled = engine.sourcePriority.filter((id) => !engine.disabledSources.includes(id));
  const errors: string[] = [];
  const results = await Promise.all(
    enabled.map(async (sourceId) => {
      try {
        return await sourceById(sourceId).search(track, searchResultLimit);
      } catch (error) {
        errors.push(`${sourceId}: ${(error as Error).message}`);
        return [];
      }
    })
  );

  const candidates = results
    .flat()
    .filter((candidate) => !quarantined.has(candidate.id))
    .sort((left, right) => {
      const scoreDelta = right.score.overall - left.score.overall;
      // Source priority only breaks near-ties; a clearly better match wins wherever it came from.
      return Math.abs(scoreDelta) > 2 ? scoreDelta : enabled.indexOf(left.providerId) - enabled.indexOf(right.providerId) || scoreDelta;
    })
    .slice(0, maxCandidatesKept);

  if (candidates.length === 0 && errors.length === enabled.length && errors.length > 0) {
    throw new Error(errors.join(" "));
  }
  return candidates;
}

/** Downloads, verifies, tags, and imports one candidate. Returns "retry" when the source was rejected. */
async function acquireCandidate(
  settings: PrivateSettings,
  job: DownloadJob,
  item: DownloadJobItem,
  candidate: CatalogProviderCandidate
): Promise<"done" | "retry"> {
  const libraryPath = path.resolve(settings.naming.libraryPath);
  const stagingDirectory = await createDownloadStagingDirectory(libraryPath);
  const source = sourceById(candidate.providerId);

  try {
    item.status = "downloading";
    item.message = `Downloading from ${source.label}.`;
    item.error = undefined;
    touch(job);

    let fetched: FetchedAudio & { format: ProviderDownloadFormat };
    try {
      fetched = await withProviderFormatFallback(settings, async (format) => {
        const profile = providerDownloadProfile(settings, format);
        const raw = await source.fetch(candidate, {
          stagingDirectory,
          fileBase: `nc-${item.id}`,
          format,
          quality: profile.quality
        });
        const stagedPath = await normalizeStagedAudioFile({ format, quality: profile.quality, stagedPath: raw.stagedPath });
        return { ...raw, stagedPath, format };
      });
    } catch (error) {
      recordAttempt(item, candidate, "download-failed", (error as Error).message);
      return "retry";
    }

    if (job.status === "cancelled") {
      item.status = "cancelled";
      item.message = "Cancelled; the download was discarded.";
      touch(job);
      return "done";
    }

    item.status = "verifying";
    item.message = "Verifying duration, quality, and fingerprint.";
    touch(job);

    const verification = await verifyStagedDownload(settings, item.track, fetched.stagedPath, {
      codec: fetched.sourceCodec,
      bitrateKbps: fetched.sourceBitrateKbps
    });
    item.verification = verification.verification;
    if (!verification.ok) {
      throw new VerificationFailure(verification);
    }

    await tagStagedDownload(fetched.stagedPath, item.track);
    const imported = await importIntoLibrary(settings, job, item, candidate, fetched.stagedPath, fetched.format);
    if (!imported) {
      return "retry";
    }

    candidate.verified = true;
    item.status = "completed";
    item.completedAt = new Date().toISOString();
    item.message = item.replaceTrackId ? "Upgraded; the previous copy is in the recycle bin." : "Imported into the library.";
    resolveWanted(item.track.key);
    touch(job);
    return "done";
  } catch (error) {
    if (error instanceof VerificationFailure) {
      recordAttempt(item, candidate, error.result.reason, error.result.message);
      quarantineCandidate(candidate.id, item.track.key, error.result.reason, error.result.message);
      return "retry";
    }
    recordAttempt(item, candidate, "download-failed", (error as Error).message);
    return "retry";
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function importIntoLibrary(
  settings: PrivateSettings,
  job: DownloadJob,
  item: DownloadJobItem,
  candidate: CatalogProviderCandidate,
  stagedPath: string,
  format: ProviderDownloadFormat
) {
  const libraryPath = path.resolve(settings.naming.libraryPath);
  const planned = downloadTrackToTrackFile(settings, item.track, format);
  const catalog = await loadCatalog();
  const replaced = item.replaceTrackId ? catalog.tracks.find((track) => track.id === item.replaceTrackId) : undefined;

  if (replaced && planned.qualityScore <= replaced.qualityScore) {
    recordAttempt(item, candidate, "not-better", "The new copy would not be higher quality than the one you have.");
    item.status = "skipped";
    item.message = `Kept your existing ${replaced.extension.replace(".", "").toUpperCase()}: the best available download is not better.`;
    item.completedAt = new Date().toISOString();
    touch(job);
    return true;
  }

  const destination = await nextAvailableFilePath(path.resolve(libraryPath, ...planned.targetRelativePath.split("/")));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await moveFile(stagedPath, destination);
  const stats = await fs.stat(destination);
  const imported: TrackFile = downloadTrackToTrackFile(settings, item.track, format, {
    absolutePath: destination,
    size: stats.size,
    mtimeMs: stats.mtimeMs
  });

  if (replaced) {
    const trashed = await trashLibraryTracks(settings, catalog.tracks, [replaced.id]);
    if (trashed.errors.length > 0) {
      item.message = `Imported the upgrade, but the old copy could not be recycled: ${trashed.errors[0]}`;
    }
    await saveCatalog(trashed.tracks);
  }

  await upsertCatalogTracks([imported]);
  publish({ type: "catalog-changed", updatedAt: new Date().toISOString() });
  item.relativePath = toPosixRelative(libraryPath, destination);
  recordDownloadProvenance({
    album: item.track.album,
    artists: item.track.artists,
    bytesWritten: stats.size,
    destinationPath: destination,
    format,
    providerId: candidate.providerId,
    quality: providerDownloadProfile(settings, format).quality,
    relativePath: item.relativePath,
    sourceUrl: candidate.url,
    trackKey: item.track.key,
    trackName: item.track.title
  });
  return true;
}

function recordAttempt(item: DownloadJobItem, candidate: CatalogProviderCandidate, reason: DownloadAttempt["reason"], message: string) {
  item.attempts.push({ candidateId: candidate.id, at: new Date().toISOString(), reason, message });
  item.error = message;
}

function failItem(job: DownloadJob, item: DownloadJobItem, reason: string, addToWanted: boolean) {
  item.status = "failed";
  item.error = reason;
  item.message = addToWanted ? `${reason} Added to Wanted for background retries.` : reason;
  item.completedAt = new Date().toISOString();
  if (addToWanted && !item.replaceTrackId) {
    recordWanted(item.track, reason, item.attempts.at(-1)?.message ?? reason);
  }
  touch(job);
}

function refreshJob(job: DownloadJob) {
  const counts = emptyCounts();
  for (const item of job.items) {
    counts[item.status] += 1;
  }
  counts.total = job.items.length;
  job.counts = counts;

  if (job.status === "cancelled") {
    return;
  }

  const active = counts.pending + counts.searching + counts.downloading + counts.verifying;
  const started = job.items.some((item) => item.status !== "pending");
  if (active > 0) {
    job.status = started ? "running" : "queued";
  } else if (counts.review > 0) {
    job.status = "review";
  } else if (counts.completed > 0 && counts.failed === 0) {
    job.status = "completed";
  } else if (counts.completed > 0) {
    job.status = "partial";
  } else if (counts.failed > 0) {
    job.status = "failed";
  } else {
    job.status = "completed";
  }

  if (terminalJobStatuses.has(job.status)) {
    job.completedAt ??= new Date().toISOString();
  } else {
    delete job.completedAt;
  }
}

function touch(job: DownloadJob) {
  job.updatedAt = new Date().toISOString();
  refreshJob(job);
  saveJob(job);
  publishJob(job);
}

function saveJob(job: DownloadJob) {
  execute(
    `INSERT INTO download_jobs (id, status, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
    job.id,
    job.status,
    JSON.stringify(job),
    job.createdAt,
    job.updatedAt
  );
  pruneFinishedJobs();
}

function pruneFinishedJobs() {
  const finished = [...jobs.values()]
    .filter((job) => terminalJobStatuses.has(job.status))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const job of finished.slice(finishedJobRetention)) {
    jobs.delete(job.id);
    execute("DELETE FROM download_jobs WHERE id = ?", job.id);
  }
}

function publishJob(job: DownloadJob) {
  publish({ type: "download-job", job: summary(job) });
}

function summary(job: DownloadJob): DownloadJobSummary {
  const { items: _items, ...rest } = job;
  return rest;
}

function emptyCounts(): DownloadJob["counts"] {
  return {
    total: 0,
    pending: 0,
    searching: 0,
    review: 0,
    downloading: 0,
    verifying: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0
  };
}

function requireJob(jobId: string) {
  const job = jobs.get(jobId);
  if (!job) {
    throw new EngineNotFoundError("Download not found.");
  }
  return job;
}

function requireItem(job: DownloadJob, itemId: string) {
  const item = job.items.find((entry) => entry.id === itemId);
  if (!item) {
    throw new EngineNotFoundError("Track not found in this download.");
  }
  return item;
}

async function requireSettings() {
  if (!loadSettings) {
    throw new Error("The download engine has not been initialized.");
  }
  return loadSettings();
}

async function moveFile(source: string, target: string) {
  try {
    await fs.rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    await fs.unlink(source);
  }
}

export class EngineNotFoundError extends Error {}
