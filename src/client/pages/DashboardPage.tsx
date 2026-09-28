import {
  Activity,
  ArrowRight,
  Ban,
  Download,
  FolderInput,
  ListChecks,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Shield
} from "lucide-react";
import { useEffect, useState } from "react";
import type { DownloadJobSummary, LibraryStats, NavidromeScanStatus, ScanStatus } from "../../shared/types";
import { api } from "../api";
import { ActionProgress, DeterminateProgress, StagePill, StatusPill } from "../components/common";
import { Artwork, Badge, Section, Spinner, Stat } from "../components/ui";
import { useLive, useLiveEvent } from "../lib/events";
import { formatDate, formatRelative, formatScanDate, navidromeScanActionLabel, plural } from "../lib/format";
import { navigate, routeHref } from "../lib/router";
import { scanProgress } from "../scan-progress";

export function DashboardPage({
  stats,
  statsLoading,
  onRefreshStats
}: {
  stats: LibraryStats | null;
  statsLoading: boolean;
  onRefreshStats: () => Promise<void>;
}) {
  const live = useLive();
  const [scanBusy, setScanBusy] = useState<"start" | "cancel" | null>(null);
  const [navidrome, setNavidrome] = useState<NavidromeScanStatus | null>(null);
  const [navidromeError, setNavidromeError] = useState<string | null>(null);
  const [navidromeBusy, setNavidromeBusy] = useState<"quick" | "full" | null>(null);
  const [jobs, setJobs] = useState<DownloadJobSummary[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const scan = live.scan;
  const progress = scanProgress(scan, null);
  const scanRunning = Boolean(scan?.running);

  useEffect(() => {
    let cancelled = false;
    let timer: number;
    const poll = async () => {
      let running = false;
      try {
        const next = await api<NavidromeScanStatus>("/navidrome/scan/status", { signal: AbortSignal.timeout(35_000) });
        if (!cancelled) {
          setNavidrome(next);
          setNavidromeError(null);
          running = next.running;
        }
      } catch (error) {
        if (!cancelled) setNavidromeError((error as Error).message);
      }
      if (!cancelled) timer = window.setTimeout(poll, running ? 2000 : 10_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    api<{ jobs: DownloadJobSummary[] }>("/downloads")
      .then((body) => setJobs(body.jobs.slice(0, 5)))
      .catch(() => undefined);
  }, []);

  useLiveEvent((event) => {
    if (event.type === "download-job") {
      setJobs((current) => [event.job, ...current.filter((job) => job.id !== event.job.id)].slice(0, 5));
    }
    if (event.type === "scan" && !event.status.running && scan?.running) {
      void onRefreshStats();
    }
  });

  const startScan = async () => {
    setScanBusy("start");
    setNotice(null);
    try {
      await api<ScanStatus>("/scan/start", { method: "POST" });
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setScanBusy(null);
    }
  };

  const cancelScan = async () => {
    setScanBusy("cancel");
    try {
      await api<ScanStatus>("/scan/cancel", { method: "POST" });
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setScanBusy(null);
    }
  };

  const startNavidromeScan = async (fullScan: boolean) => {
    setNavidromeBusy(fullScan ? "full" : "quick");
    setNotice(null);
    try {
      setNavidrome(await api<NavidromeScanStatus>("/navidrome/scan/start", { method: "POST", body: JSON.stringify({ fullScan }) }));
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setNavidromeBusy(null);
    }
  };

  const workflow = stats?.workflow;
  const needsFirstScan = Boolean(stats && !workflow?.scanned && !scanRunning);
  const metricValue = (value: number | undefined) =>
    statsLoading && !stats ? <Spinner size={20} /> : needsFirstScan ? "—" : (value ?? 0).toLocaleString();
  const stage = workflow?.stage ?? "scan";
  const engine = live.engine;

  return (
    <div className="dashboard">
      {notice && <div className="notice-bar">{notice}</div>}

      {needsFirstScan && (
        <div className="hero-callout">
          <div>
            <h2>Scan your library to get started</h2>
            <p>NaviClean reads tags, reuses MusicBrainz IDs already in your files, and fingerprints anything unidentified. Nothing on disk changes until you apply a plan.</p>
          </div>
          <button className="primary-button" type="button" onClick={startScan} disabled={Boolean(scanBusy)}>
            {scanBusy === "start" ? <Spinner size={18} /> : <RefreshCw size={18} />}
            <span>Scan library</span>
          </button>
        </div>
      )}

      <div className="stat-grid">
        <Stat label="Tracks" value={metricValue(stats?.totalTracks)} hint={stats?.lastScanFinishedAt ? `Updated ${formatRelative(stats.lastScanFinishedAt)}` : undefined} onClick={() => navigate("library")} />
        <Stat
          label="Identity review"
          value={metricValue(workflow?.metadataReview)}
          tone={(workflow?.metadataReview ?? 0) > 0 ? "attention" : undefined}
          hint="Tracks awaiting a confirmed release"
          onClick={() => navigate("organize")}
        />
        <Stat
          label="Pending moves"
          value={metricValue(stats?.pendingMoves)}
          tone={(stats?.pendingMoves ?? 0) > 0 ? "attention" : undefined}
          hint="Ready to apply in Organize"
          onClick={() => navigate("organize")}
        />
        <Stat
          label="Duplicate groups"
          value={metricValue(stats?.duplicateGroups)}
          tone={(stats?.duplicateGroups ?? 0) > 0 ? "attention" : undefined}
          hint={workflow?.duplicateScanReady ? "Same release, same track" : "Unlocks after organizing"}
          onClick={() => navigate("duplicates")}
        />
      </div>

      <div className="dashboard-grid">
        <Section
          title={<><ListChecks size={18} /> Cleanup workflow</>}
          description={workflow?.message ?? "Scan the library to start cleanup."}
          className="workflow-card"
        >
          <div className="workflow-steps">
            <StagePill label="1 · Scan" active={stage === "scan"} complete={Boolean(workflow?.scanned)} />
            <ArrowRight size={14} aria-hidden="true" />
            <StagePill label="2 · Organize" active={stage === "organize"} complete={stage === "duplicates"} />
            <ArrowRight size={14} aria-hidden="true" />
            <StagePill label="3 · Duplicates" active={stage === "duplicates"} complete={false} />
          </div>
          {stage === "organize" && (
            <a className="primary-button fit" href={routeHref("organize")}>
              <FolderInput size={18} />
              <span>Review organization</span>
            </a>
          )}
          {stage === "duplicates" && (
            <a className="primary-button fit" href={routeHref("duplicates")}>
              <span>Review duplicates</span>
              <ArrowRight size={18} />
            </a>
          )}
          <p className="supporting-note">
            <Shield size={15} aria-hidden="true" /> Preview changes before applying them, and keep a current backup of your library.
          </p>
        </Section>

        <Section title={<><Activity size={18} /> Index & scans</>} className="scans-card">
          <div className="scan-row">
            <div className="scan-row-copy">
              <strong>NaviClean library scan</strong>
              <span>
                {scanRunning
                  ? progress.detail
                  : scan?.finishedAt
                    ? `${scan.phase === "cancelled" ? "Cancelled" : "Finished"} ${formatRelative(scan.finishedAt)}${scan.cachedFiles ? ` · ${scan.cachedFiles.toLocaleString()} unchanged files reused` : ""}`
                    : "Reads tags, MusicBrainz IDs, and fingerprints"}
              </span>
            </div>
            <StatusPill active={progress.active} label={progress.label} />
            {scanRunning ? (
              <button className="secondary-button compact-button" type="button" onClick={cancelScan} disabled={scanBusy === "cancel"}>
                {scanBusy === "cancel" ? <Spinner /> : <Ban size={16} />}
                <span>Cancel</span>
              </button>
            ) : (
              <button className="secondary-button compact-button" type="button" onClick={startScan} disabled={Boolean(scanBusy)}>
                {scanBusy === "start" ? <Spinner /> : <RefreshCw size={16} />}
                <span>Run scan</span>
              </button>
            )}
          </div>
          {scanRunning && (progress.percent === null
            ? <ActionProgress label={progress.detail} />
            : <DeterminateProgress label={progress.detail} value={progress.percent} />)}
          {progress.warning && <div className="error-list"><span>{progress.warning}</span></div>}
          {!scanRunning && scan?.errors.length ? (
            <details className="scan-notes">
              <summary>{plural(scan.errors.length, "file error")}</summary>
              {scan.errors.slice(0, 8).map((item) => <span key={item}>{item}</span>)}
            </details>
          ) : null}
          {!scanRunning && scan?.warnings.length ? (
            <details className="scan-notes">
              <summary>{plural(scan.warnings.length, "scan note")}</summary>
              {scan.warnings.map((item) => <span key={item}>{item}</span>)}
            </details>
          ) : null}

          <div className="scan-row">
            <div className="scan-row-copy">
              <strong>Navidrome index</strong>
              <span>
                {navidrome?.configured
                  ? `${(navidrome.count ?? 0).toLocaleString()} files · ${navidrome.lastScan ? `last scan ${formatScanDate(navidrome.lastScan)}` : "not scanned"}`
                  : navidrome ? "Connection not configured" : "Checking…"}
              </span>
            </div>
            <StatusPill
              active={Boolean(navidrome?.running)}
              label={navidromeError || navidrome?.error ? "Unavailable" : !navidrome ? "Loading" : !navidrome.configured ? "Off" : navidrome.running ? "Running" : "Idle"}
            />
            {navidrome?.configured ? (
              <div className="compact-action-row">
                <button className="secondary-button compact-button" type="button" onClick={() => startNavidromeScan(false)} disabled={Boolean(navidromeBusy) || navidrome.running}>
                  {navidromeBusy === "quick" ? <Spinner /> : <RefreshCw size={16} />}
                  <span>Quick</span>
                </button>
                <button className="secondary-button compact-button" type="button" onClick={() => startNavidromeScan(true)} disabled={Boolean(navidromeBusy) || navidrome.running}>
                  {navidromeBusy === "full" ? <Spinner /> : <Search size={16} />}
                  <span>Full</span>
                </button>
              </div>
            ) : (
              <a className="secondary-button compact-button" href={routeHref("settings", { section: "connections" })}>
                <Settings size={16} />
                <span>Connect</span>
              </a>
            )}
          </div>
          {navidrome?.running && <ActionProgress label={`${navidromeScanActionLabel(navidrome.scanType)} running in Navidrome`} />}
          {(navidromeError || navidrome?.error) && <div className="error-list"><span>{navidromeError || navidrome?.error}</span></div>}
          {scan?.startedAt && (
            <p className="supporting-note">Last NaviClean scan started {formatDate(scan.startedAt)}. Run Navidrome's full scan after large moves so both indexes agree.</p>
          )}
        </Section>
      </div>

      <div className="dashboard-grid">
        <Section
          title={<><Download size={18} /> Downloads</>}
          actions={<a className="text-link" href={routeHref("downloads")}>Open queue <ArrowRight size={14} /></a>}
        >
          <div className="mini-stats">
            <span><strong>{engine?.activeJobs ?? 0}</strong> active</span>
            <a href={routeHref("downloads", { tab: "review" })} className={(engine?.reviewCount ?? 0) > 0 ? "attention" : ""}>
              <strong>{engine?.reviewCount ?? 0}</strong> to review
            </a>
            <a href={routeHref("downloads", { tab: "wanted" })}><strong>{engine?.wantedCount ?? 0}</strong> wanted</a>
          </div>
          {jobs.length === 0 ? (
            <p className="muted">Nothing downloaded yet. Find an album in Discover to request it.</p>
          ) : (
            <ul className="job-mini-list">
              {jobs.map((job) => (
                <li key={job.id}>
                  <Artwork src={job.coverUrl} label={job.title} size="sm" />
                  <a href={routeHref("downloads", { job: job.id })}>
                    <strong>{job.title}</strong>
                    <span>{job.counts.completed}/{job.counts.total - job.counts.skipped} done · {formatRelative(job.updatedAt)}</span>
                  </a>
                  <JobStatusBadge status={job.status} />
                </li>
              ))}
            </ul>
          )}
          {engine?.sources.some((source) => !source.available) && (
            <p className="supporting-note warning-note">
              {engine.sources.filter((source) => !source.available).map((source) => `${source.label}: ${source.message}`).join(" ")}
            </p>
          )}
        </Section>

        <Section
          title={<><Radio size={18} /> Following</>}
          actions={<a className="text-link" href={routeHref("following")}>All releases <ArrowRight size={14} /></a>}
        >
          {(engine?.newReleaseCount ?? 0) > 0 ? (
            <p>
              <Badge tone="info">{engine?.newReleaseCount} new</Badge> releases from artists you follow are waiting in Following.
            </p>
          ) : (
            <p className="muted">Follow artists from Discover to hear about their new albums, EPs, and singles.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

export function JobStatusBadge({ status }: { status: DownloadJobSummary["status"] }) {
  const tone = status === "completed"
    ? "success"
    : status === "failed"
      ? "danger"
      : status === "review" || status === "partial"
        ? "warning"
        : status === "cancelled"
          ? "neutral"
          : "accent";
  const label = status === "review" ? "Needs review" : status.charAt(0).toUpperCase() + status.slice(1);
  return <Badge tone={tone}>{label}</Badge>;
}
