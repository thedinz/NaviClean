import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleAlert,
  CopyX,
  Loader2,
  Music2,
  Play,
  RefreshCw,
  Search
} from "lucide-react";
import type {
  AudioConvertExtensionGroup,
  AudioConvertFile,
  AudioConvertJob,
  AudioConvertQuality,
  AudioConvertTargetFormat,
  AudioConvertView
} from "../../shared/types";
import { api } from "../api";
import { ActionProgress, DeterminateProgress, EmptyState, StatusPill } from "../components/common";
import { formatBytes, formatDate, formatDuration, libraryMeta, pathFilename, pluralize } from "../lib/format";

export const audioConvertTargetOptions: Array<{
  id: AudioConvertTargetFormat;
  extension: string;
  label: string;
  description: string;
  lossless: boolean;
}> = [
  { id: "mp3", extension: ".mp3", label: "MP3", description: "Maximum compatibility", lossless: false },
  { id: "m4a", extension: ".m4a", label: "M4A / AAC", description: "Efficient Apple-friendly audio", lossless: false },
  { id: "opus", extension: ".opus", label: "Opus", description: "Efficient modern audio", lossless: false },
  { id: "ogg", extension: ".ogg", label: "OGG Vorbis", description: "Open lossy audio", lossless: false },
  { id: "flac", extension: ".flac", label: "FLAC", description: "Lossless archive format", lossless: true },
  { id: "wav", extension: ".wav", label: "WAV", description: "Uncompressed PCM", lossless: true }
];

export const audioConvertLossyQualityOptions: Array<{ id: AudioConvertQuality; label: string; description: string }> = [
  { id: "128k", label: "128 kbps", description: "Smaller files" },
  { id: "192k", label: "192 kbps", description: "Balanced" },
  { id: "256k", label: "256 kbps", description: "High quality" },
  { id: "320k", label: "320 kbps", description: "Highest common bitrate" }
];

export const audioConvertLosslessQualityOption = {
  id: "lossless" as const,
  label: "Lossless",
  description: "No target bitrate"
};

export function ConvertPage({ onChanged }: { onChanged: () => Promise<void> }) {
  const [view, setView] = useState<AudioConvertView | null>(null);
  const [sourceExtension, setSourceExtension] = useState("");
  const [targetFormat, setTargetFormat] = useState<AudioConvertTargetFormat>("mp3");
  const [quality, setQuality] = useState<AudioConvertQuality>("320k");
  const [job, setJob] = useState<AudioConvertJob | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [convertSearch, setConvertSearch] = useState("");
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const refreshedJobIds = useRef<Set<string>>(new Set());

  const groups = view?.groups || [];
  const selectedGroup = groups.find((group) => group.extension === sourceExtension) || groups[0] || null;
  const targetOptions = audioConvertTargetOptions.filter((option) => option.extension !== selectedGroup?.extension);
  const selectedTargetOption = audioConvertTargetOption(targetFormat) || targetOptions[0];
  const qualityOptions = audioConvertQualityOptionsForTarget(selectedTargetOption?.id || targetFormat);
  const activeJob = isAudioConvertJobActive(job);
  const targetQuality = selectedTargetOption?.lossless ? "lossless" : quality;
  const selectedGroupFiles = selectedGroup?.files || [];
  const filteredConvertFiles = useMemo(
    () => filterAudioConvertFiles(selectedGroupFiles, convertSearch),
    [selectedGroupFiles, convertSearch]
  );
  const selectedConvertFiles = selectedGroupFiles.filter((file) => selectedTrackIds.has(file.id));
  const selectedConvertFileIds = selectedConvertFiles.map((file) => file.id);
  const selectedConvertSize = selectedConvertFiles.reduce((total, file) => total + file.size, 0);
  const filteredSelectedCount = filteredConvertFiles.filter((file) => selectedTrackIds.has(file.id)).length;
  const allFilteredSelected = filteredConvertFiles.length > 0 && filteredSelectedCount === filteredConvertFiles.length;

  const load = async ({ clearNotice = true }: { clearNotice?: boolean } = {}) => {
    setLoading(true);

    if (clearNotice) {
      setNotice(null);
      setError(null);
    }

    try {
      const next = await api<AudioConvertView>("/convert");
      setView(next);

      if (next.groups.length > 0 && !next.groups.some((group) => group.extension === sourceExtension)) {
        setSourceExtension(next.groups[0].extension);
      }
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load({ clearNotice: false });
    api<{ job: AudioConvertJob | null }>("/convert/jobs/active")
      .then((body) => {
        if (body.job) {
          setJob(body.job);
        }
      })
      .catch((caught) => setError((caught as Error).message));
  }, []);

  useEffect(() => {
    if (!selectedGroup) {
      setConvertSearch("");
      setSelectedTrackIds(new Set());
      return;
    }

    setConvertSearch("");
    setSelectedTrackIds(new Set(selectedGroup.files.map((file) => file.id)));
  }, [selectedGroup?.extension, selectedGroup?.count]);

  useEffect(() => {
    if (!selectedGroup) {
      return;
    }

    const nextTarget = defaultAudioConvertTarget(selectedGroup.extension);

    if (audioConvertTargetOption(targetFormat)?.extension === selectedGroup.extension) {
      setTargetFormat(nextTarget);
    }
  }, [selectedGroup?.extension, targetFormat]);

  useEffect(() => {
    const target = audioConvertTargetOption(targetFormat);

    if (target?.lossless && quality !== "lossless") {
      setQuality("lossless");
    }

    if (target && !target.lossless && quality === "lossless") {
      setQuality("320k");
    }
  }, [targetFormat, quality]);

  useEffect(() => {
    if (!job || !isAudioConvertJobActive(job)) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      api<{ job: AudioConvertJob }>(`/convert/jobs/${encodeURIComponent(job.id)}`)
        .then((body) => setJob(body.job))
        .catch((caught) => setError((caught as Error).message));
    }, 1200);

    return () => window.clearInterval(interval);
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!job || isAudioConvertJobActive(job) || refreshedJobIds.current.has(job.id)) {
      return;
    }

    refreshedJobIds.current.add(job.id);
    setNotice(audioConvertJobNotice(job));
    void load({ clearNotice: false });
    void onChanged().catch((caught) => setError((caught as Error).message));
  }, [job?.id, job?.status]);

  const startConversion = async () => {
    if (!selectedGroup || !selectedTargetOption) {
      return;
    }

    if (selectedConvertFileIds.length === 0) {
      setError("Choose at least one file to convert.");
      return;
    }

    const confirmed = window.confirm(
      `Convert ${selectedConvertFileIds.length.toLocaleString()} selected ${selectedGroup.extension.toUpperCase()} ${pluralize("file", selectedConvertFileIds.length)} to ${selectedTargetOption.extension.toUpperCase()}? Originals are deleted after each successful conversion.`
    );

    if (!confirmed) {
      return;
    }

    setBusy(true);
    setNotice(null);
    setError(null);

    try {
      const body = await api<{ job: AudioConvertJob }>("/convert/jobs", {
        method: "POST",
        body: JSON.stringify({
          quality: targetQuality,
          sourceExtension: selectedGroup.extension,
          targetFormat: selectedTargetOption.id,
          trackIds: selectedConvertFileIds
        })
      });
      setJob(body.job);
      setNotice(`Conversion started for ${selectedConvertFileIds.length.toLocaleString()} ${pluralize("file", selectedConvertFileIds.length)}.`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleConvertFile = (fileId: string, checked: boolean) => {
    setSelectedTrackIds((current) => {
      const next = new Set(current);

      if (checked) {
        next.add(fileId);
      } else {
        next.delete(fileId);
      }

      return next;
    });
  };

  const toggleFilteredConvertFiles = (checked: boolean) => {
    setSelectedTrackIds((current) => {
      const next = new Set(current);

      for (const file of filteredConvertFiles) {
        if (checked) {
          next.add(file.id);
        } else {
          next.delete(file.id);
        }
      }

      return next;
    });
  };

  return (
    <section className="stack convert-page">
      <div className="notice-bar safety app-risk-banner" role="note">
        <CircleAlert size={18} aria-hidden="true" />
        <div>
          <strong>Conversion replaces originals</strong>
          <span>
            NaviClean writes each converted file beside the original, then deletes the original only after that item succeeds.
            Back up the library first if you want to keep source files.
          </span>
          <span>Converting lossy files to FLAC or WAV will not restore quality that is already gone.</span>
        </div>
      </div>

      <section className="panel">
        <div className="toolbar">
          <div className="summary-chips">
            <span>{(view?.totalFiles || 0).toLocaleString()} audio files</span>
            <span>{groups.length.toLocaleString()} formats</span>
            <span>{formatBytes(view?.totalSize || 0)}</span>
          </div>
          <div className="button-row">
            <button className="secondary-button" type="button" onClick={() => load()} disabled={loading || busy || activeJob}>
              {loading ? <Loader2 className="spin" size={18} /> : <RefreshCw size={18} />}
              <span>{loading ? "Loading" : "Refresh"}</span>
            </button>
            <button
              className="primary-button"
              type="button"
              onClick={startConversion}
              disabled={loading || busy || activeJob || !selectedGroup || !selectedTargetOption || selectedConvertFileIds.length === 0}
            >
              {busy || activeJob ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              <span>{activeJob ? "Converting" : "Convert"}</span>
            </button>
          </div>
        </div>

        {loading && <ActionProgress label="Loading convertible audio files" />}
        {notice && <div className="notice-bar">{notice}</div>}
        {error && <p className="form-error">{error}</p>}

        {!loading && groups.length === 0 ? (
          <EmptyState
            icon={Music2}
            title="No audio formats found"
            description="Run a NaviClean scan so the converter can read the current catalog."
          />
        ) : (
          <div className="convert-layout">
            <div className="convert-controls">
              <label>
                Source format
                <div className="filter-select">
                  <select
                    value={selectedGroup?.extension || ""}
                    onChange={(event) => setSourceExtension(event.target.value)}
                    disabled={activeJob}
                  >
                    {groups.map((group) => (
                      <option key={group.extension} value={group.extension}>
                        {group.extension.toUpperCase()} - {group.count.toLocaleString()} {pluralize("file", group.count)}
                      </option>
                    ))}
                  </select>
                </div>
              </label>

              <label>
                Convert to
                <div className="filter-select">
                  <select
                    value={selectedTargetOption?.id || targetFormat}
                    onChange={(event) => setTargetFormat(event.target.value as AudioConvertTargetFormat)}
                    disabled={activeJob}
                  >
                    {targetOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </label>

              <label>
                Quality
                <div className="filter-select">
                  <select
                    value={targetQuality}
                    onChange={(event) => setQuality(event.target.value as AudioConvertQuality)}
                    disabled={activeJob || selectedTargetOption?.lossless}
                  >
                    {qualityOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            </div>

            {selectedGroup && selectedTargetOption && (
              <div className="convert-summary">
                <strong>
                  {selectedGroup.extension.toUpperCase()} to {selectedTargetOption.extension.toUpperCase()}
                </strong>
                <span>
                  {selectedConvertFileIds.length.toLocaleString()} selected / {selectedGroup.count.toLocaleString()} total / {formatBytes(selectedConvertSize)} / {audioConvertQualityLabel(targetQuality)}
                </span>
                <span>{selectedTargetOption.description}</span>
              </div>
            )}

            {selectedGroup && (
              <ConvertFileTable
                activeJob={activeJob}
                allFilteredSelected={allFilteredSelected}
                files={filteredConvertFiles}
                filteredSelectedCount={filteredSelectedCount}
                group={selectedGroup}
                onSearchChange={setConvertSearch}
                onToggleFile={toggleConvertFile}
                onToggleFiltered={toggleFilteredConvertFiles}
                search={convertSearch}
                selectedCount={selectedConvertFileIds.length}
                selectedTrackIds={selectedTrackIds}
              />
            )}
          </div>
        )}
      </section>

      {job && (
        <section className="panel convert-job-panel">
          <div className="panel-title split">
            <div>
              <h2>Conversion Job</h2>
              <span>{audioConvertJobStatusLabel(job)}</span>
            </div>
            <StatusPill active={isAudioConvertJobActive(job)} label={job.status} />
          </div>
          <DeterminateProgress label={audioConvertJobProgressLabel(job)} value={audioConvertJobProgress(job)} />
          <div className="summary-chips">
            <span>{job.completedCount.toLocaleString()} completed</span>
            <span>{job.failedCount.toLocaleString()} failed</span>
            <span>{job.pendingCount.toLocaleString()} remaining</span>
            <span>{job.sourceExtension.toUpperCase()} to {audioConvertTargetOption(job.targetFormat)?.extension.toUpperCase()}</span>
            <span>{audioConvertQualityLabel(job.quality)}</span>
          </div>
          {job.errors.length > 0 && (
            <div className="error-list">
              {job.errors.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          )}
          <div className="table-wrap">
            <table className="convert-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Target</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Size</th>
                </tr>
              </thead>
              <tbody>
                {job.items.map((item) => (
                  <tr key={item.trackId}>
                    <td>
                      <strong>{pathFilename(item.sourceRelativePath)}</strong>
                      <span>{item.sourceRelativePath}</span>
                      {item.error && <span className="status-detail">{item.error}</span>}
                    </td>
                    <td>
                      <span>{item.targetRelativePath}</span>
                    </td>
                    <td>{audioConvertItemStatusLabel(item.status)}</td>
                    <td>{item.status === "converting" ? `${item.progress}%` : item.status === "completed" ? "100%" : ""}</td>
                    <td>
                      <span>{formatBytes(item.sourceSize)}</span>
                      {item.outputSize ? <span>{formatBytes(item.outputSize)}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}

export function ConvertFileTable({
  activeJob,
  allFilteredSelected,
  files,
  filteredSelectedCount,
  group,
  onSearchChange,
  onToggleFile,
  onToggleFiltered,
  search,
  selectedCount,
  selectedTrackIds
}: {
  activeJob: boolean;
  allFilteredSelected: boolean;
  files: AudioConvertFile[];
  filteredSelectedCount: number;
  group: AudioConvertExtensionGroup;
  onSearchChange: (value: string) => void;
  onToggleFile: (fileId: string, checked: boolean) => void;
  onToggleFiltered: (checked: boolean) => void;
  search: string;
  selectedCount: number;
  selectedTrackIds: Set<string>;
}) {
  return (
    <div className="convert-file-panel">
      <div className="convert-file-toolbar">
        <div className="search-box convert-search">
          <Search size={17} />
          <input
            disabled={activeJob}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search files"
            value={search}
          />
        </div>
        <div className="summary-chips">
          <span>{selectedCount.toLocaleString()} selected</span>
          <span>{files.length.toLocaleString()} shown</span>
          <span>{filteredSelectedCount.toLocaleString()} shown selected</span>
        </div>
        <div className="button-row">
          <button
            className="secondary-button"
            disabled={activeJob || files.length === 0}
            onClick={() => onToggleFiltered(true)}
            type="button"
          >
            <Check size={17} />
            <span>Select matching</span>
          </button>
          <button
            className="secondary-button"
            disabled={activeJob || files.length === 0}
            onClick={() => onToggleFiltered(false)}
            type="button"
          >
            <CopyX size={17} />
            <span>Clear matching</span>
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table className="convert-table">
          <thead>
            <tr>
              <th className="convert-select-cell">
                <input
                  aria-label="Toggle matching files"
                  checked={allFilteredSelected}
                  className="convert-file-checkbox"
                  disabled={activeJob || files.length === 0}
                  onChange={(event) => onToggleFiltered(event.target.checked)}
                  type="checkbox"
                />
              </th>
              <th>File</th>
              <th>Track</th>
              <th>Quality</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {files.length === 0 ? (
              <tr>
                <td colSpan={5}>No matching {group.extension.toUpperCase()} files</td>
              </tr>
            ) : (
              files.map((file) => (
                <tr key={file.id}>
                  <td className="convert-select-cell">
                    <input
                      aria-label={`Select ${pathFilename(file.relativePath)}`}
                      checked={selectedTrackIds.has(file.id)}
                      className="convert-file-checkbox"
                      disabled={activeJob}
                      onChange={(event) => onToggleFile(file.id, event.target.checked)}
                      type="checkbox"
                    />
                  </td>
                  <td>
                    <strong>{pathFilename(file.relativePath)}</strong>
                    <span>{file.relativePath}</span>
                  </td>
                  <td>
                    <strong>{file.title}</strong>
                    <span>{libraryMeta([file.artist, file.album, file.duration ? formatDuration(file.duration) : ""])}</span>
                  </td>
                  <td>{audioConvertFileSummary(file)}</td>
                  <td>{formatBytes(file.size)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function filterAudioConvertFiles(files: AudioConvertFile[], search: string) {
  const query = search.trim().toLowerCase();

  if (!query) {
    return files;
  }

  return files.filter((file) =>
    [file.relativePath, file.title, file.artist, file.album, file.extension]
      .join(" ")
      .toLowerCase()
      .includes(query)
  );
}

export function isAudioConvertJobActive(job: AudioConvertJob | null) {
  return job?.status === "queued" || job?.status === "running";
}

export function audioConvertJobProgress(job: AudioConvertJob) {
  if (job.totalCount <= 0) {
    return 0;
  }

  const totalProgress = job.items.reduce((total, item) => {
    if (item.status === "completed" || item.status === "failed") {
      return total + 100;
    }

    return total + item.progress;
  }, 0);

  return totalProgress / job.totalCount;
}

export function audioConvertJobNotice(job: AudioConvertJob) {
  const converted = `${job.completedCount.toLocaleString()} ${pluralize("file", job.completedCount)} converted`;
  const failed = job.failedCount > 0 ? `, ${job.failedCount.toLocaleString()} failed` : "";

  return `${converted}${failed}.`;
}

export function audioConvertJobProgressLabel(job: AudioConvertJob) {
  if (isAudioConvertJobActive(job) && job.pendingCount === 0) {
    return "Refreshing catalog";
  }

  if (isAudioConvertJobActive(job)) {
    return "Converting audio files";
  }

  return audioConvertJobNotice(job);
}

export function audioConvertJobStatusLabel(job: AudioConvertJob) {
  if (job.status === "completed") {
    return `Finished ${formatDate(job.completedAt || job.updatedAt)}`;
  }

  if (job.status === "failed") {
    return `Failed ${formatDate(job.completedAt || job.updatedAt)}`;
  }

  if (job.status === "queued") {
    return "Queued";
  }

  return "Running";
}

export function audioConvertItemStatusLabel(status: AudioConvertJob["items"][number]["status"]) {
  if (status === "converting") {
    return "Converting";
  }

  if (status === "completed") {
    return "Done";
  }

  if (status === "failed") {
    return "Failed";
  }

  return "Pending";
}

export function audioConvertTargetOption(format: AudioConvertTargetFormat) {
  return audioConvertTargetOptions.find((option) => option.id === format);
}

export function defaultAudioConvertTarget(sourceExtension: string): AudioConvertTargetFormat {
  return sourceExtension === ".mp3" ? "m4a" : "mp3";
}

export function audioConvertQualityOptionsForTarget(targetFormat: AudioConvertTargetFormat) {
  const target = audioConvertTargetOption(targetFormat);

  if (target?.lossless) {
    return [audioConvertLosslessQualityOption];
  }

  return audioConvertLossyQualityOptions;
}

export function audioConvertQualityLabel(quality: AudioConvertQuality) {
  const option = [...audioConvertLossyQualityOptions, audioConvertLosslessQualityOption].find(
    (candidate) => candidate.id === quality
  );

  return option ? `${option.label} / ${option.description}` : quality;
}

export function audioConvertFileSummary(file: AudioConvertFile) {
  return libraryMeta([
    file.lossless ? "lossless" : "",
    file.bitrate ? `${Math.round(file.bitrate / 1000)}k` : "",
    file.duration ? formatDuration(file.duration) : ""
  ]);
}
