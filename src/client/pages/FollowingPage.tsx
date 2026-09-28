import { CheckCheck, Download, EyeOff, Heart, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArtistRelease, DownloadJob, FollowedArtist } from "../../shared/types";
import { api } from "../api";
import { ActionProgress, EmptyState } from "../components/common";
import { Artwork, Badge, RightsConfirmation, Section, Spinner } from "../components/ui";
import { useLive } from "../lib/events";
import { formatRelative, plural } from "../lib/format";
import { routeHref } from "../lib/router";

type FollowsResponse = { follows: FollowedArtist[]; releases?: ArtistRelease[] };

export function FollowingPage() {
  const live = useLive();
  const [follows, setFollows] = useState<FollowedArtist[] | null>(null);
  const [releases, setReleases] = useState<ArtistRelease[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);

  const apply = (body: FollowsResponse) => {
    setFollows(body.follows);
    if (body.releases) setReleases(body.releases);
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    void run("load", async () => {
      apply(await api<FollowsResponse>("/follows"));
      // Opening the page counts as seeing the new releases.
      await api("/releases/seen", { method: "POST", body: JSON.stringify({}) });
      await live.refreshEngine();
    });
  }, []);

  const newReleases = releases.filter((release) => release.status === "new" || release.status === "queued");

  if (!follows) {
    return error ? <div className="error-list"><span>{error}</span></div> : <ActionProgress label="Loading followed artists" />;
  }

  return (
    <div className="page-stack">
      {notice && <div className="notice-bar success">{notice}</div>}
      {error && <div className="error-list"><span>{error}</span></div>}

      <Section
        title="New releases"
        description="Studio albums, EPs, and singles that appeared on MusicBrainz after you followed the artist."
        actions={
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={Boolean(busy) || follows.length === 0}
            onClick={() => void run("check", async () => {
              apply(await api<FollowsResponse>("/follows/check", { method: "POST" }));
              setNotice("Checked every followed artist for new releases.");
            })}
          >
            {busy === "check" ? <Spinner /> : <RefreshCw size={16} />}
            <span>Check now</span>
          </button>
        }
      >
        {newReleases.length === 0 ? (
          <EmptyState icon={CheckCheck} title="You're up to date" description="NaviClean checks followed artists in the background and lists anything new here." />
        ) : (
          <>
            <RightsConfirmation checked={rightsConfirmed} onChange={setRightsConfirmed} />
            <div className="release-feed">
              {newReleases.map((release) => (
                <article className="release-row" key={release.id}>
                  <Artwork src={`https://coverartarchive.org/release-group/${release.id}/front-250`} label={release.title} size="sm" />
                  <div>
                    <strong>{release.title}</strong>
                    <span>
                      <a href={routeHref("discover", { artist: release.artistId })}>{release.artistName}</a> · {release.primaryType} · {release.firstReleaseDate || "Date unknown"}
                    </span>
                  </div>
                  {release.inLibrary && <Badge tone="success">In library</Badge>}
                  {release.status === "queued" && <Badge tone="accent">Queued</Badge>}
                  <div className="row-actions">
                    <a className="secondary-button compact-button" href={routeHref("discover", { artist: release.artistId, rg: release.id })}>View</a>
                    <button
                      className="primary-button compact-button"
                      type="button"
                      disabled={!rightsConfirmed || Boolean(busy) || release.status === "queued"}
                      onClick={() => void run(`download:${release.id}`, async () => {
                        const { job } = await api<{ job: DownloadJob }>(`/releases/${release.id}/download`, {
                          method: "POST",
                          body: JSON.stringify({ rightsConfirmed })
                        });
                        setReleases((current) => current.map((entry) => (entry.id === release.id ? { ...entry, status: "queued" } : entry)));
                        setNotice(`Queued ${job.title}.`);
                      })}
                    >
                      {busy === `download:${release.id}` ? <Spinner /> : <Download size={16} />}
                      <span>Download</span>
                    </button>
                    <button
                      className="icon-button"
                      type="button"
                      title="Dismiss"
                      disabled={Boolean(busy)}
                      onClick={() => void run(`dismiss:${release.id}`, async () => {
                        await api(`/releases/${release.id}/dismiss`, { method: "POST" });
                        setReleases((current) => current.map((entry) => (entry.id === release.id ? { ...entry, status: "dismissed" } : entry)));
                      })}
                    >
                      <EyeOff size={16} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Section>

      <Section title={`Following ${plural(follows.length, "artist")}`} description="Follow artists from their page in Discover.">
        {follows.length === 0 ? (
          <EmptyState icon={Heart} title="Not following anyone yet" description="Open an artist in Discover and choose Follow." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Artist</th><th>Auto-download new releases</th><th>Last checked</th><th aria-label="Actions" /></tr>
              </thead>
              <tbody>
                {follows.map((follow) => (
                  <tr key={follow.artistId}>
                    <td>
                      <a href={routeHref("discover", { artist: follow.artistId })}><strong>{follow.name}</strong></a>
                      <span className="muted">{follow.disambiguation || `Following since ${formatRelative(follow.createdAt)}`}</span>
                    </td>
                    <td>
                      <label className="switch">
                        <input
                          type="checkbox"
                          checked={follow.autoDownload}
                          disabled={Boolean(busy)}
                          onChange={(event) => void run(`auto:${follow.artistId}`, async () => {
                            apply(await api<FollowsResponse>(`/follows/${follow.artistId}`, {
                              method: "PATCH",
                              body: JSON.stringify({ autoDownload: event.target.checked })
                            }));
                          })}
                        />
                        <span>{follow.autoDownload ? "On" : "Off"}</span>
                      </label>
                    </td>
                    <td>{formatRelative(follow.lastCheckedAt)}</td>
                    <td>
                      <button
                        className="icon-button danger-icon"
                        type="button"
                        title={`Unfollow ${follow.name}`}
                        disabled={Boolean(busy)}
                        onClick={() => {
                          if (window.confirm(`Stop following ${follow.name}?`)) {
                            void run(`unfollow:${follow.artistId}`, async () => apply(await api<FollowsResponse>(`/follows/${follow.artistId}`, { method: "DELETE" })));
                          }
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
