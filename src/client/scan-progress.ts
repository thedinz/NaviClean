import type { ScanStatus } from "../shared/types.js";

export function scanProgress(scan: ScanStatus | null, statusError: string | null, now = Date.now()) {
  const stalled = Boolean(scan?.running && scan.progressAt && now - Date.parse(scan.progressAt) > 120_000);
  const active = Boolean(scan?.running && !statusError && !stalled);
  const phases = {
    discovering: "Discovering library files",
    metadata: "Reading audio tags",
    identifying: "Fingerprinting and identifying audio",
    navidrome: "Comparing with the Navidrome index",
    saving: "Saving NaviClean catalog",
    complete: "Scan completed",
    failed: "Scan failed"
  };
  const phase = scan?.phase ? phases[scan.phase] : "Scan in progress";
  const count = scan?.totalFiles
    ? `${(scan.processedFiles ?? 0).toLocaleString()} / ${scan.totalFiles.toLocaleString()} files in this stage`
    : `${(scan?.scannedFiles ?? 0).toLocaleString()} files discovered`;
  return {
    active,
    label: statusError ? "Status unavailable" : stalled ? "No recent progress" : !scan ? "Loading" : scan.running ? "Running" : scan.phase === "failed" ? "Failed" : scan.finishedAt ? "Finished" : "Ready",
    detail: `${phase} · ${count}`,
    warning: statusError ? `Cannot verify NaviClean scan status: ${statusError}` : stalled ? "No scan progress reported for over 2 minutes. The scan may be waiting or stuck; animation is paused until progress resumes." : null,
    percent: scan?.totalFiles && (scan.phase === "metadata" || scan.phase === "identifying")
      ? (scan.processedFiles ?? 0) / scan.totalFiles * 100
      : null
  };
}
