import {
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Link2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
  X
} from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import type {
  CatalogProviderCandidate,
  DownloadItemStatus,
  DownloadJob,
  DownloadJobItem,
  DownloadJobSummary,
  DownloadReviewItem,
  QuarantineEntry,
  WantedItem
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState } from "../components/common";
import { Artwork, Badge, ProgressBar, Spinner, Tabs } from "../components/ui";
import { useLive, useLiveEvent } from "../lib/events";
import { formatProviderDuration, formatRelative, plural, providerLabel } from "../lib/format";
import { navigate, type Route } from "../lib/router";
import { JobStatusBadge } from "./DashboardPage";

type DownloadsTab = "queue" | "review" | "wanted" | "quarantine";

export function DownloadsPage({ route }: { route: Route }) {
  const live = useLive();
  const requested = route.params.get("tab") as DownloadsTab | null;
  const tab: DownloadsTab = requested && ["queue", "review", "wanted", "quarantine"].includes(requested) ? requested : "queue";
  const setTab = (next: DownloadsTab) => navigate("downloads", { tab: next === "queue" ? null : next });

  return (
    <div className="page-stack">
      <Tabs<DownloadsTab>
        label="Downloads"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "queue", label: "Queue", count: live.engine?.activeJobs },
          { id: "review", label: "Review", count: live.engine?.reviewCount, tone: "attention" },
          { id: "wanted", label: "Wanted", count: live.engine?.wantedCount },
          { id: "quarantine", label: "Quarantine" }
        ]}
      />
      {tab === "queue" && <QueueTab expandedJobId={route.params.get("job")} />}
      {tab === "review" && <ReviewTab />}
      {tab === "wanted" && <WantedTab />}
      {tab === "quarantine" && <QuarantineTab />}
    </div>
  );
}

function QueueTab({ expandedJobId }: { expandedJobId: string | null }) {
  const [jobs, setJobs] = useState<DownloadJobSummary[] | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(expandedJobId ? { [expandedJobId]: true } : {});
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setJobs((await api<{ jobs: DownloadJobSummary[] }>("/downloads")).jobs);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useLiveEvent((event) => {
    if (event.type === "download-job") {
      setJobs((current) => {
        const list = current ?? [];
        const exists = list.some((job) => job.id === event.job.id);
        return exists ? list.map((job) => (job.id === event.job.id ? event.job : job)) : [event.job, ...list];
      });
    }
  });

  const clearFinished = async () => {
    try {
      setJobs((await api<{ jobs: DownloadJobSummary[] }>("/downloads/finished", { method: "DELETE" })).jobs);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  if (!jobs) {
    return error ? <div className="error-list"><span>{error}</span></div> : <ActionProgress label="Loading downloads" />;
  }

  const finished = jobs.filter((job) => ["completed", "partial", "failed", "cancelled"].includes(job.status)).length;

  return (
    <section className="panel">
      <div className="toolbar">
        <span className="muted">{plural(jobs.length, "download")} · jobs resume automatically if NaviClean restarts</span>
        {finished > 0 && (
          <button className="secondary-button compact-button" type="button" onClick={clearFinished}>
            <Trash2 size={16} />
            <span>Clear {finished} finished</span>
          </button>
        )}
      </div>
      {error && <div className="error-list"><span>{error}</span></div>}
      {jobs.length === 0 ? (
        <EmptyState icon={Search} title="No downloads yet" description="Pick an album in Discover, or follow artists to get their new releases." />
      ) : (
        <div className="job-list">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              expanded={Boolean(expanded[job.id])}
              onToggle={() => setExpanded((current) => ({ ...current, [job.id]: !current[job.id] }))}
              onRemoved={() => setJobs((current) => current?.filter((entry) => entry.id !== job.id) ?? null)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function JobCard({
  job,
  expanded,
  onToggle,
  onRemoved
}: {
  job: DownloadJobSummary;
  expanded: boolean;
  onToggle: () => void;
  onRemoved: () => void;
}) {
  const [detail, setDetail] = useState<DownloadJob | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);
  const counted = job.counts.total - job.counts.skipped;
  const done = job.counts.completed + job.counts.failed + job.counts.cancelled;
  const active = ["queued", "running"].includes(job.status);

  const loadDetail = async () => {
    try {
      setDetail((await api<{ job: DownloadJob }>(`/downloads/${job.id}`)).job);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  useEffect(() => {
    if (expanded) void loadDetail();
  }, [expanded]);

  useEffect(() => {
    // Refresh the open item list when the job summary changes, at most twice a second.
    if (!expanded) return;
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void loadDetail(), 500);
    return () => window.clearTimeout(refreshTimer.current);
  }, [job.updatedAt, expanded]);

  const act = async (key: string, path: string, method = "POST") => {
    setBusy(key);
    setError(null);
    try {
      await api(path, { method });
      if (key === "remove") onRemoved();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`job-card ${job.status}`}>
      <div className="job-card-main">
        <button className="icon-button plain" type="button" onClick={onToggle} aria-label={expanded ? "Collapse" : "Expand"}>
          {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
        </button>
        <Artwork src={job.coverUrl} label={job.title} size="sm" />
        <button className="job-card-title" type="button" onClick={onToggle}>
          <strong>{job.title}</strong>
          <span>{job.subtitle || `${job.origin} download`} · {formatRelative(job.createdAt)}</span>
        </button>
        <div className="job-card-progress">
          <ProgressBar value={counted > 0 ? (done / counted) * 100 : 100} label={`${job.title} progress`} />
          <span>
            {job.counts.completed}/{counted} imported
            {job.counts.failed ? ` · ${job.counts.failed} failed` : ""}
            {job.counts.review ? ` · ${job.counts.review} to review` : ""}
            {job.counts.skipped ? ` · ${job.counts.skipped} skipped` : ""}
          </span>
        </div>
        <JobStatusBadge status={job.status} />
        <div className="job-card-actions">
          {active && (
            <button className="icon-button" type="button" title="Cancel" onClick={() => void act("cancel", `/downloads/${job.id}/cancel`)} disabled={Boolean(busy)}>
              {busy === "cancel" ? <Spinner /> : <Ban size={16} />}
            </button>
          )}
          {(job.counts.failed > 0 || job.counts.cancelled > 0) && !active && (
            <button className="icon-button" type="button" title="Retry failed tracks" onClick={() => void act("retry", `/downloads/${job.id}/retry`)} disabled={Boolean(busy)}>
              {busy === "retry" ? <Spinner /> : <RotateCcw size={16} />}
            </button>
          )}
          {!active && (
            <button className="icon-button" type="button" title="Remove from list" onClick={() => void act("remove", `/downloads/${job.id}`, "DELETE")} disabled={Boolean(busy)}>
              {busy === "remove" ? <Spinner /> : <X size={16} />}
            </button>
          )}
        </div>
      </div>
      {error && <div className="error-list"><span>{error}</span></div>}
      {expanded && (
        detail ? (
          <div className="table-wrap">
            <table className="job-items">
              <thead>
                <tr><th>#</th><th>Track</th><th>Status</th><th>Source</th><th>Checks</th></tr>
              </thead>
              <tbody>
                {detail.items.map((item) => <JobItemRow key={item.id} item={item} />)}
              </tbody>
            </table>
          </div>
        ) : (
          <ActionProgress label="Loading tracks" />
        )
      )}
    </article>
  );
}

function JobItemRow({ item }: { item: DownloadJobItem }) {
  const candidate = item.candidates.find((entry) => entry.id === item.selectedCandidateId) ?? (item.status === "completed" ? item.candidates.find((entry) => entry.verified) : undefined);
  const verification = item.verification;

  return (
    <tr>
      <td className="track-number">{item.track.discTotal && item.track.discTotal > 1 ? `${item.track.discNumber}-` : ""}{item.track.trackNumber}</td>
      <td>
        <strong>{item.track.title}</strong>
        <span>{item.track.artists.join(", ")}</span>
        {item.relativePath && <span className="path-diff">{item.relativePath}</span>}
      </td>
      <td>
        <ItemStatusBadge status={item.status} />
        {(item.error || item.message) && <span className={item.status === "failed" ? "error-text" : "muted"}>{item.error && item.status === "failed" ? item.error : item.message}</span>}
        {item.attempts.length > 0 && item.status !== "failed" && (
          <span className="muted">{plural(item.attempts.length, "source")} rejected before this one</span>
        )}
      </td>
      <td>
        {candidate ? <CandidateSummary candidate={candidate} /> : item.candidates.length > 0 ? <span className="muted">{plural(item.candidates.length, "candidate")}</span> : <span className="muted">—</span>}
      </td>
      <td>
        {verification ? (
          <div className="check-list">
            {verification.durationDeltaSeconds !== null && <span><Check size={12} /> Length ±{verification.durationDeltaSeconds}s</span>}
            {verification.sourceBitrateKbps !== null && <span><Check size={12} /> {verification.sourceBitrateKbps} kbps {verification.sourceCodec ?? ""}</span>}
            <span className={`fingerprint-${verification.fingerprint}`}>
              {verification.fingerprint === "match" ? <Check size={12} /> : verification.fingerprint === "mismatch" ? <X size={12} /> : null}
              Fingerprint {verification.fingerprint}
            </span>
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

function ItemStatusBadge({ status }: { status: DownloadItemStatus }) {
  const tone = status === "completed" ? "success" : status === "failed" ? "danger" : status === "review" ? "warning" : status === "skipped" || status === "cancelled" ? "neutral" : "accent";
  const active = status === "searching" || status === "downloading" || status === "verifying";
  return (
    <Badge tone={tone}>
      {active && <Spinner size={11} />}
      {status === "review" ? "Needs review" : status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

function CandidateSummary({ candidate }: { candidate: CatalogProviderCandidate }) {
  return (
    <div className="candidate-summary">
      <span className="provider-pill">{providerLabel(candidate.providerId)}</span>
      <a href={candidate.url} target="_blank" rel="noreferrer" title="Open source">
        {candidate.title} <ExternalLink size={12} />
      </a>
      <span className="muted">
        {candidate.channel ?? candidate.artists.join(", ")} · {formatProviderDuration(candidate.durationMs)} · score {candidate.score.overall}
      </span>
      {candidate.flags?.length ? (
        <span className="flag-row">{candidate.flags.map((flag) => <FlagBadge key={flag} flag={flag} />)}</span>
      ) : null}
    </div>
  );
}

function FlagBadge({ flag }: { flag: string }) {
  const labels: Record<string, [string, "success" | "warning" | "danger" | "neutral" | "info"]> = {
    "topic-channel": ["Official audio", "success"],
    "artist-channel": ["Artist channel", "success"],
    vevo: ["VEVO", "info"],
    "official-audio": ["Official audio", "success"],
    "music-video": ["Music video", "warning"],
    "third-party": ["Re-upload", "warning"],
    "duration-far": ["Length differs", "danger"],
    "manual-url": ["Your link", "info"]
  };
  if (flag.startsWith("version:")) {
    return <Badge tone="danger">{flag.slice(8)} version</Badge>;
  }
  const [label, tone] = labels[flag] ?? [flag, "neutral"];
  return <Badge tone={tone}>{label}</Badge>;
}

function ReviewTab() {
  const [items, setItems] = useState<DownloadReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useLive();

  const load = async () => {
    try {
      setItems((await api<{ items: DownloadReviewItem[] }>("/downloads/review")).items);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, [live.engine?.reviewCount]);

  if (!items) {
    return error ? <div className="error-list"><span>{error}</span></div> : <ActionProgress label="Loading review queue" />;
  }

  return (
    <section className="panel">
      <p className="supporting-note">
        These tracks had a plausible match that did not score high enough to download automatically. Approving still runs the duration, quality, and fingerprint checks.
      </p>
      {items.length === 0 ? (
        <EmptyState icon={Check} title="Nothing to review" description="Uncertain matches wait here instead of being imported." />
      ) : (
        <div className="review-list">
          {items.map((entry) => (
            <ReviewCard key={entry.item.id} entry={entry} onDone={() => setItems((current) => current?.filter((item) => item.item.id !== entry.item.id) ?? null)} />
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewCard({ entry, onDone }: { entry: DownloadReviewItem; onDone: () => void }) {
  const { item, jobId } = entry;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  const post = async (key: string, path: string, body: Record<string, unknown> = {}) => {
    setBusy(key);
    setError(null);
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const base = `/downloads/${jobId}/items/${item.id}`;

  return (
    <article className="review-card">
      <header>
        <Artwork src={item.track.coverUrl} label={item.track.album} size="sm" />
        <div>
          <strong>{item.track.title}</strong>
          <span>{item.track.artists.join(", ")} · {item.track.album} · {formatProviderDuration(item.track.durationMs)}</span>
          {item.message && <span className="muted">{item.message}</span>}
        </div>
        <div className="button-row">
          <button className="secondary-button compact-button" type="button" onClick={() => void post("search", `${base}/search`)} disabled={Boolean(busy)}>
            {busy === "search" ? <Spinner /> : <RefreshCw size={16} />}
            <span>Search again</span>
          </button>
          <button className="secondary-button compact-button" type="button" onClick={() => void post("reject", `${base}/reject`, { keepWanted: true })} disabled={Boolean(busy)}>
            {busy === "reject" ? <Spinner /> : <X size={16} />}
            <span>Reject</span>
          </button>
        </div>
      </header>
      {error && <div className="error-list"><span>{error}</span></div>}
      <ul className="candidate-list">
        {item.candidates.map((candidate) => {
          const tried = item.attempts.find((attempt) => attempt.candidateId === candidate.id);
          return (
            <li key={candidate.id} className={tried ? "tried" : ""}>
              <span className={`score ${candidate.score.overall >= 80 ? "high" : candidate.score.overall >= 55 ? "mid" : "low"}`}>{candidate.score.overall}</span>
              <CandidateSummary candidate={candidate} />
              {tried ? (
                <span className="error-text">{tried.message}</span>
              ) : (
                <button className="primary-button compact-button" type="button" onClick={() => void post(candidate.id, `${base}/approve`, { candidateId: candidate.id })} disabled={Boolean(busy)}>
                  {busy === candidate.id ? <Spinner /> : <Check size={16} />}
                  <span>Use this</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form
        className="paste-url"
        onSubmit={(event) => {
          event.preventDefault();
          void post("url", `${base}/approve`, { url: url.trim() });
        }}
      >
        <Link2 size={16} />
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="Or paste a YouTube or JioSaavn link" />
        <button className="secondary-button compact-button" type="submit" disabled={!url.trim() || Boolean(busy)}>
          {busy === "url" ? <Spinner /> : <Play size={16} />}
          <span>Use link</span>
        </button>
      </form>
    </article>
  );
}

function WantedTab() {
  const [items, setItems] = useState<WantedItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = async () => {
    try {
      setItems((await api<{ items: WantedItem[] }>("/wanted")).items);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (key: string, path: string, method = "POST") => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const body = await api<{ items: WantedItem[]; job?: DownloadJob | null }>(path, { method });
      setItems(body.items);
      if (body.job) {
        setNotice(`Started a search for ${plural(body.job.counts.pending, "track")}.`);
      } else if (key === "run") {
        setNotice("Nothing is due yet. Use Retry on a track to search for it now.");
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!items) {
    return error ? <div className="error-list"><span>{error}</span></div> : <ActionProgress label="Loading wanted tracks" />;
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <span className="muted">Re-searched in the background: after 1 hour, 6 hours, 1 day, 3 days, then weekly.</span>
        <button className="secondary-button compact-button" type="button" onClick={() => void act("run", "/wanted/run")} disabled={Boolean(busy)}>
          {busy === "run" ? <Spinner /> : <Play size={16} />}
          <span>Search due tracks now</span>
        </button>
      </div>
      {notice && <div className="notice-bar">{notice}</div>}
      {error && <div className="error-list"><span>{error}</span></div>}
      {items.length === 0 ? (
        <EmptyState icon={Check} title="Nothing wanted" description="Tracks that could not be found or verified wait here for another try." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Track</th><th>Why</th><th>Attempts</th><th>Next search</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.track.title}</strong>
                    <span>{item.track.artists.join(", ")} · {item.track.album}</span>
                  </td>
                  <td>
                    <span>{item.reason}</span>
                    {item.lastError && item.lastError !== item.reason && <span className="muted">{item.lastError}</span>}
                  </td>
                  <td>{item.attempts}</td>
                  <td>{item.status === "paused" ? <Badge>Paused</Badge> : item.status === "searching" ? <Badge tone="accent">Searching</Badge> : formatRelative(item.nextAttemptAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button className="icon-button" type="button" title="Search now" onClick={() => void act(`retry:${item.id}`, `/wanted/${encodeURIComponent(item.id)}/retry`)} disabled={Boolean(busy)}>
                        {busy === `retry:${item.id}` ? <Spinner /> : <RefreshCw size={16} />}
                      </button>
                      {item.status === "paused" ? (
                        <button className="icon-button" type="button" title="Resume" onClick={() => void act(`resume:${item.id}`, `/wanted/${encodeURIComponent(item.id)}/resume`)} disabled={Boolean(busy)}>
                          <Play size={16} />
                        </button>
                      ) : (
                        <button className="icon-button" type="button" title="Pause" onClick={() => void act(`pause:${item.id}`, `/wanted/${encodeURIComponent(item.id)}/pause`)} disabled={Boolean(busy)}>
                          <Pause size={16} />
                        </button>
                      )}
                      <button className="icon-button danger-icon" type="button" title="Stop wanting" onClick={() => void act(`remove:${item.id}`, `/wanted/${encodeURIComponent(item.id)}`, "DELETE")} disabled={Boolean(busy)}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function QuarantineTab() {
  const [entries, setEntries] = useState<QuarantineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (method = "GET", query = "") => {
    try {
      setEntries((await api<{ entries: QuarantineEntry[] }>(`/quarantine${query}`, { method })).entries);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (!entries) {
    return error ? <div className="error-list"><span>{error}</span></div> : <ActionProgress label="Loading quarantine" />;
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <span className="muted">
          <ShieldAlert size={15} /> Sources that failed verification for a track are never picked for it again.
        </span>
        {entries.length > 0 && (
          <button className="secondary-button compact-button" type="button" onClick={() => void load("DELETE")}>
            <Trash2 size={16} />
            <span>Release all</span>
          </button>
        )}
      </div>
      {error && <div className="error-list"><span>{error}</span></div>}
      {entries.length === 0 ? (
        <EmptyState icon={Check} title="Quarantine is empty" />
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Source</th><th>Reason</th><th>When</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {entries.map((entry) => (
                <Fragment key={`${entry.candidateId}|${entry.trackKey}`}>
                  <tr>
                    <td>
                      <strong>{entry.candidateId}</strong>
                      <span className="muted">{entry.trackKey}</span>
                    </td>
                    <td><Badge tone="warning">{entry.reason}</Badge><span>{entry.detail}</span></td>
                    <td>{formatRelative(entry.createdAt)}</td>
                    <td>
                      <button
                        className="icon-button"
                        type="button"
                        title="Release"
                        onClick={() => void load("DELETE", `?candidateId=${encodeURIComponent(entry.candidateId)}&trackKey=${encodeURIComponent(entry.trackKey)}`)}
                      >
                        <RotateCcw size={16} />
                      </button>
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
