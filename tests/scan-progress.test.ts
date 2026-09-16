import assert from "node:assert/strict";
import { test } from "node:test";
import { scanProgress } from "../src/client/scan-progress.js";
import type { ScanStatus } from "../src/shared/types.js";

const now = Date.parse("2026-09-16T16:00:00Z");
const running: ScanStatus = {
  running: true, startedAt: new Date(now - 60_000).toISOString(), finishedAt: null,
  phase: "metadata", progressAt: new Date(now).toISOString(),
  scannedFiles: 10, audioFiles: 4, processedFiles: 5, totalFiles: 10,
  errors: [], warnings: []
};

test("scan progress counts attempted files and names the actual stage", () => {
  const view = scanProgress(running, null, now);
  assert.equal(view.active, true);
  assert.equal(view.percent, 50);
  assert.match(view.detail, /Reading audio tags · 5 \/ 10 files in this stage/);
});

test("stale and unreachable scans do not animate or claim live progress", () => {
  const stale = scanProgress(running, null, now + 121_000);
  assert.equal(stale.active, false);
  assert.equal(stale.label, "No recent progress");
  assert.ok(stale.warning);
  const unreachable = scanProgress(running, "Request timed out", now);
  assert.equal(unreachable.active, false);
  assert.equal(unreachable.label, "Status unavailable");
  assert.equal(scanProgress({ ...running, progressAt: new Date(now + 121_000).toISOString() }, null, now + 122_000).active, true);
});

test("idle, finished and failed scans never animate", () => {
  assert.equal(scanProgress(null, null, now).label, "Loading");
  const completed = scanProgress({ ...running, running: false, phase: "complete", finishedAt: new Date(now).toISOString() }, null, now);
  assert.equal(completed.active, false);
  assert.equal(completed.label, "Finished");
  assert.equal(scanProgress({ ...running, running: false, phase: "failed" }, null, now).label, "Failed");
});
