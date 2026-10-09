import { ArrowUpCircle, Check, Settings } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DownloadJob, UpgradeCandidate, UpgradeView } from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState } from "../components/common";
import { Badge, RightsConfirmation, Section, Spinner } from "../components/ui";
import { plural } from "../lib/format";
import { routeHref } from "../lib/router";

export function UpgradesPage() {
  const [view, setView] = useState<UpgradeView | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<DownloadJob | null>(null);

  useEffect(() => {
    api<UpgradeView>("/upgrades")
      .then(setView)
      .catch((caught) => setError((caught as Error).message));
  }, []);

  const albums = useMemo(() => {
    const groups = new Map<string, UpgradeCandidate[]>();
    for (const candidate of view?.candidates ?? []) {
      const key = `${candidate.track.albumArtist || candidate.track.artist} — ${candidate.track.album}`;
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
    return [...groups.entries()];
  }, [view]);

  const selectedIds = Object.entries(selected).filter(([, value]) => value).map(([id]) => id);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ job: DownloadJob }>("/upgrades", {
        method: "POST",
        body: JSON.stringify({ trackIds: selectedIds, rightsConfirmed })
      });
      setJob(body.job);
      setSelected({});
      setRightsConfirmed(false);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) {
    return error ? <div className="error-list"><span>{error}</span></div> : <ActionProgress label="Checking library quality" />;
  }

  return (
    <div className="page-stack">
      <Section
        title={`${plural(view.candidates.length, "track")} below your quality floor`}
        description="NaviClean searches for a better copy, verifies it like any download, and only replaces the file if the new copy is higher quality. The original goes to the recycle bin."
        actions={
          <a className="secondary-button compact-button" href={routeHref("settings", { section: "downloads" })}>
            <Settings size={16} />
            <span>Quality floors</span>
          </a>
        }
      >
        {job && (
          <div className="notice-bar success">
            <span>Started an upgrade for {plural(job.counts.pending, "track")}.</span>
            <a className="text-link" href={routeHref("downloads", { job: job.id })}>Follow progress</a>
          </div>
        )}
        {error && <div className="error-list"><span>{error}</span></div>}
        {view.candidates.length === 0 ? (
          <EmptyState icon={Check} title="Everything meets your quality floor" description={`All ${view.totalTracks.toLocaleString()} tracks are lossless or at or above the minimum bitrate for their format.`} />
        ) : (
          <>
            <div className="upgrade-groups">
              {albums.map(([album, candidates]) => {
                const allSelected = candidates.every((candidate) => selected[candidate.track.id]);
                return (
                  <details className="upgrade-group" key={album} open={albums.length <= 6}>
                    <summary>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) =>
                          setSelected((current) => ({
                            ...current,
                            ...Object.fromEntries(candidates.map((candidate) => [candidate.track.id, event.target.checked]))
                          }))
                        }
                        aria-label={`Select ${album}`}
                      />
                      <strong>{album}</strong>
                      <Badge tone="warning">{plural(candidates.length, "track")}</Badge>
                    </summary>
                    <ul>
                      {candidates.map((candidate) => (
                        <li key={candidate.track.id}>
                          <label className="checkbox-label">
                            <input
                              type="checkbox"
                              checked={Boolean(selected[candidate.track.id])}
                              onChange={(event) => setSelected((current) => ({ ...current, [candidate.track.id]: event.target.checked }))}
                            />
                            <span>{candidate.track.trackNumber ? `${String(candidate.track.trackNumber).padStart(2, "0")} · ` : ""}{candidate.track.title}</span>
                          </label>
                          <span className="muted">{candidate.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </div>
            <div className="download-bar">
              <RightsConfirmation checked={rightsConfirmed} onChange={setRightsConfirmed} disabled={busy} />
              <button className="primary-button" type="button" onClick={start} disabled={busy || !rightsConfirmed || selectedIds.length === 0}>
                {busy ? <Spinner size={18} /> : <ArrowUpCircle size={18} />}
                <span>Upgrade {plural(selectedIds.length, "track")}</span>
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}
