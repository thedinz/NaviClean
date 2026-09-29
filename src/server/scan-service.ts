import type { ScanStatus } from "../shared/types.js";
import { publish } from "./events.js";
import { withLibraryLock } from "./library-lock.js";
import { invalidateOrganizeEvaluationCache } from "./organize-service.js";
import { ScanCancelledError, scanLibrary } from "./scanner.js";
import { loadSettings, type PrivateSettings } from "./settings.js";

const scanStatus: ScanStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  scannedFiles: 0,
  audioFiles: 0,
  errors: [],
  warnings: []
};
let currentScan: Promise<void> | null = null;
let scanAbortController: AbortController | null = null;
let autoScanTimer: NodeJS.Timeout | null = null;
let lastScanPublishAt = 0;
let trailingScanPublish: NodeJS.Timeout | null = null;

export function getScanStatus(): ScanStatus {
  return scanStatus;
}

export function isScanRunning() {
  return scanStatus.running;
}

/** Starts a scan in the background. Returns false when one is already running. */
export function startBackgroundScan() {
  if (scanStatus.running) {
    return false;
  }

  const now = new Date().toISOString();
  Object.assign(scanStatus, {
    running: true,
    phase: "discovering",
    processedFiles: 0,
    totalFiles: 0,
    progressAt: now,
    startedAt: now,
    finishedAt: null,
    scannedFiles: 0,
    audioFiles: 0,
    errors: [],
    warnings: []
  } satisfies Partial<ScanStatus>);

  currentScan = runScan().finally(() => {
    currentScan = null;
  });
  return true;
}

export function cancelScan() {
  scanAbortController?.abort();
}

/**
 * Waits for any running scan, then runs a fresh one and waits for it. Used after operations
 * (such as conversion) whose results must be visible in the catalog before they report done.
 */
export async function scanAndWait(): Promise<ScanStatus> {
  while (currentScan) {
    await currentScan;
  }

  startBackgroundScan();
  await currentScan;
  return scanStatus;
}

export function scheduleAutoScan(settings: PrivateSettings) {
  if (autoScanTimer) {
    clearTimeout(autoScanTimer);
    autoScanTimer = null;
  }

  if (!settings.scan.autoScanEnabled) {
    return;
  }

  const nextScanAt = nextDailyScanDate(settings.scan.autoScanTime);
  autoScanTimer = setTimeout(() => {
    void runScheduledScan();
  }, Math.max(0, nextScanAt.getTime() - Date.now()));
  console.log(`Daily scan scheduled for ${nextScanAt.toLocaleString()}`);
}

export function nextDailyScanDate(time: string, from = new Date()) {
  const [hour = "2", minute = "0"] = time.split(":");
  const next = new Date(from);
  next.setHours(Number(hour), Number(minute), 0, 0);

  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

async function runScan() {
  const controller = new AbortController();
  scanAbortController = controller;

  try {
    // The scan replaces the whole catalog, so it holds the library lock for its full duration;
    // mutations are rejected while it runs (see assertLibraryIdle) instead of being lost.
    await withLibraryLock(async () => {
      const settings = await loadSettings();
      const result = await scanLibrary(settings, (update) => {
        Object.assign(scanStatus, update, { progressAt: new Date().toISOString() });
        publishScanStatus(Boolean(update.phase));
      }, { signal: controller.signal });
      invalidateOrganizeEvaluationCache();
      scanStatus.errors = result.errors;
      scanStatus.warnings = result.warnings;
      scanStatus.phase = "complete";
    });
  } catch (error) {
    if (error instanceof ScanCancelledError) {
      scanStatus.phase = "cancelled";
      scanStatus.warnings = [error.message];
    } else {
      scanStatus.phase = "failed";
      scanStatus.errors = [(error as Error).message];
      scanStatus.warnings = [];
    }
  } finally {
    scanAbortController = null;
    scanStatus.running = false;
    scanStatus.finishedAt = new Date().toISOString();
    publishScanStatus(true);
    publish({ type: "catalog-changed", updatedAt: scanStatus.finishedAt });
  }
}

/** Streams scan progress to connected browsers: at most a few times a second, always including the latest state. */
function publishScanStatus(force = false) {
  const now = Date.now();
  const wait = 400 - (now - lastScanPublishAt);

  if (!force && wait > 0) {
    trailingScanPublish ??= setTimeout(() => {
      trailingScanPublish = null;
      publishScanStatus(true);
    }, wait);
    return;
  }

  if (trailingScanPublish) {
    clearTimeout(trailingScanPublish);
    trailingScanPublish = null;
  }

  lastScanPublishAt = now;
  publish({ type: "scan", status: { ...scanStatus } });
}

async function runScheduledScan() {
  autoScanTimer = null;

  try {
    const settings = await loadSettings();

    if (settings.scan.autoScanEnabled) {
      const started = startBackgroundScan();
      console.log(started ? "Starting scheduled daily scan." : "Skipping scheduled daily scan because another scan is running.");
    }

    scheduleAutoScan(settings);
  } catch (error) {
    console.error("Failed to start scheduled daily scan:", error);
  }
}
