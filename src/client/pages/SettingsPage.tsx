import { Activity, ArrowDown, ArrowUp, Check, Download, Fingerprint, FolderInput, KeyRound, Music2, Save, Shield, SlidersHorizontal } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AuthInfo, CatalogProviderId, EngineStatus, QualityCodecFamily, SettingsView } from "../../shared/types";
import { api } from "../api";
import { ActionProgress, MessageScreen } from "../components/common";
import { Badge, Spinner } from "../components/ui";
import { navigate, useRoute } from "../lib/router";

type SectionId = "account" | "connections" | "identification" | "downloads" | "library";

const sections: Array<{ id: SectionId; label: string; icon: typeof Shield }> = [
  { id: "account", label: "Account", icon: Shield },
  { id: "connections", label: "Connections", icon: SlidersHorizontal },
  { id: "identification", label: "Identification", icon: Fingerprint },
  { id: "downloads", label: "Downloads", icon: Download },
  { id: "library", label: "Library & scans", icon: FolderInput }
];

const codecLabels: Record<QualityCodecFamily, string> = {
  opus: "Opus",
  vorbis: "Ogg Vorbis",
  aac: "AAC / M4A",
  mp3: "MP3",
  other: "Other lossy"
};

const sourceLabels: Record<CatalogProviderId, string> = { youtube: "YouTube", jiosaavn: "JioSaavn" };

export function SettingsPage({ auth, onAuthChange }: { auth: AuthInfo; onAuthChange: (auth: AuthInfo) => void }) {
  const route = useRoute();
  const requested = route.params.get("section") as SectionId | null;
  const section: SectionId = requested && sections.some((entry) => entry.id === requested) ? requested : "account";
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [navidromePassword, setNavidromePassword] = useState("");
  const [spotifyClientSecret, setSpotifyClientSecret] = useState("");
  const [acoustIdApiKey, setAcoustIdApiKey] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api<SettingsView>("/settings")
      .then((current) => {
        setSettings(current);
        setSavedSnapshot(JSON.stringify(current));
      })
      .catch((caught) => setNotice({ tone: "error", text: (caught as Error).message }));
  }, []);

  if (!settings) {
    return notice ? <div className="error-list"><span>{notice.text}</span></div> : <MessageScreen title="Settings" message="Loading" />;
  }

  const update = (next: Partial<SettingsView>) => setSettings({ ...settings, ...next });
  const dirty = JSON.stringify(settings) !== savedSnapshot || Boolean(navidromePassword || spotifyClientSecret || acoustIdApiKey);

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy("save");
    setNotice(null);
    try {
      const next = await api<SettingsView>("/settings", {
        method: "PUT",
        body: JSON.stringify({
          auth: { enabled: settings.auth.enabled, username: settings.auth.username },
          navidrome: { ...settings.navidrome, password: navidromePassword },
          catalog: {
            spotify: { ...settings.catalog.spotify, clientSecret: spotifyClientSecret },
            providers: settings.catalog.providers,
            discovery: settings.catalog.discovery
          },
          identification: { ...settings.identification, acoustIdApiKey },
          naming: { libraryPath: settings.naming.libraryPath, recycleBinPath: settings.naming.recycleBinPath },
          scan: settings.scan,
          cleanup: settings.cleanup,
          engine: settings.engine,
          quality: settings.quality,
          musicbrainz: settings.musicbrainz
        })
      });
      setSettings(next);
      setSavedSnapshot(JSON.stringify(next));
      setNavidromePassword("");
      setSpotifyClientSecret("");
      setAcoustIdApiKey("");
      onAuthChange({ ...auth, authEnabled: next.auth.enabled, username: next.auth.username });
      setNotice({ tone: "success", text: "Settings saved." });
    } catch (caught) {
      setNotice({ tone: "error", text: (caught as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const test = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    setNotice(null);
    try {
      const result = await api<{ ok: boolean; message: string }>(path, { method: "POST", body: JSON.stringify(body) });
      setNotice({ tone: result.ok ? "success" : "error", text: result.message });
    } catch (caught) {
      setNotice({ tone: "error", text: (caught as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="settings-layout" onSubmit={save}>
      <nav className="settings-nav" aria-label="Settings sections">
        {sections.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              type="button"
              className={section === entry.id ? "active" : ""}
              onClick={() => navigate("settings", { section: entry.id })}
            >
              <Icon size={17} />
              <span>{entry.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="settings-content">
        {notice && <div className={`notice-bar ${notice.tone}`}>{notice.text}</div>}
        {busy === "save" && <ActionProgress label="Saving settings" />}

        {section === "account" && (
          <>
            <SettingsCard title="Sign-in" icon={Shield}>
              <Toggle
                label="Require sign-in"
                description="Turn off only when NaviClean sits behind another authentication layer."
                checked={settings.auth.enabled}
                onChange={(enabled) => update({ auth: { ...settings.auth, enabled } })}
              />
              <label>
                Username
                <input value={settings.auth.username} onChange={(event) => update({ auth: { ...settings.auth, username: event.target.value } })} />
              </label>
            </SettingsCard>
            <PasswordCard />
          </>
        )}

        {section === "connections" && (
          <>
            <SettingsCard
              title="Navidrome"
              icon={SlidersHorizontal}
              status={settings.navidrome.baseUrl && settings.navidrome.username && settings.navidrome.passwordSet ? "Connected" : "Not configured"}
              description="Used for artwork, index comparison, and starting Navidrome scans. NaviClean never treats Navidrome's cached tags as identity."
            >
              <label>
                URL
                <input value={settings.navidrome.baseUrl} placeholder="http://navidrome:4533" onChange={(event) => update({ navidrome: { ...settings.navidrome, baseUrl: event.target.value } })} />
              </label>
              <div className="form-row">
                <label>
                  Username
                  <input value={settings.navidrome.username} onChange={(event) => update({ navidrome: { ...settings.navidrome, username: event.target.value } })} />
                </label>
                <label>
                  Password
                  <input type="password" value={navidromePassword} placeholder={settings.navidrome.passwordSet ? "Saved" : ""} onChange={(event) => setNavidromePassword(event.target.value)} />
                </label>
              </div>
              <button
                className="secondary-button fit"
                type="button"
                disabled={busy === "navidrome"}
                onClick={() => void test("navidrome", "/navidrome/test", { baseUrl: settings.navidrome.baseUrl, username: settings.navidrome.username, password: navidromePassword })}
              >
                {busy === "navidrome" ? <Spinner /> : <Activity size={16} />}
                <span>Test connection</span>
              </button>
            </SettingsCard>

            <SettingsCard
              title="Spotify catalog"
              icon={Music2}
              status={!settings.catalog.spotify.enabled ? "Off" : settings.catalog.spotify.clientId && settings.catalog.spotify.clientSecretSet ? "Connected" : "Needs credentials"}
              description="Optional. Adds a Spotify tab to Discover and a “Find on Spotify” option in Organize. MusicBrainz works without it."
            >
              <Toggle
                label="Enable Spotify"
                checked={settings.catalog.spotify.enabled}
                onChange={(enabled) => update({ catalog: { ...settings.catalog, spotify: { ...settings.catalog.spotify, enabled } } })}
              />
              <div className="form-row">
                <label>
                  Client ID
                  <input disabled={!settings.catalog.spotify.enabled} value={settings.catalog.spotify.clientId} onChange={(event) => update({ catalog: { ...settings.catalog, spotify: { ...settings.catalog.spotify, clientId: event.target.value } } })} />
                </label>
                <label>
                  Client secret
                  <input disabled={!settings.catalog.spotify.enabled} type="password" value={spotifyClientSecret} placeholder={settings.catalog.spotify.clientSecretSet ? "Saved" : ""} onChange={(event) => setSpotifyClientSecret(event.target.value)} />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Market
                  <input disabled={!settings.catalog.spotify.enabled} maxLength={2} value={settings.catalog.spotify.market} onChange={(event) => update({ catalog: { ...settings.catalog, spotify: { ...settings.catalog.spotify, market: event.target.value.toUpperCase() } } })} />
                </label>
                <label>
                  Requests per minute
                  <input type="number" min={10} max={60} value={settings.catalog.discovery.requestsPerMinute} onChange={(event) => update({ catalog: { ...settings.catalog, discovery: { requestsPerMinute: Number(event.target.value) } } })} />
                </label>
              </div>
              <button
                className="secondary-button fit"
                type="button"
                disabled={busy === "spotify" || !settings.catalog.spotify.enabled}
                onClick={() => void test("spotify", "/spotify/test", { ...settings.catalog.spotify, clientSecret: spotifyClientSecret })}
              >
                {busy === "spotify" ? <Spinner /> : <Activity size={16} />}
                <span>Test connection</span>
              </button>
            </SettingsCard>
          </>
        )}

        {section === "identification" && (
          <>
            <SettingsCard
              title="Audio fingerprinting (AcoustID)"
              icon={Fingerprint}
              status={!settings.identification.acoustIdEnabled ? "Off" : settings.identification.acoustIdApiKeySet ? "Connected" : "Needs API key"}
              description="Identifies files by their audio and verifies downloads. Get a free application key at acoustid.org/new-application."
            >
              <Toggle label="Enable AcoustID" checked={settings.identification.acoustIdEnabled} onChange={(acoustIdEnabled) => update({ identification: { ...settings.identification, acoustIdEnabled } })} />
              <label>
                Application API key
                <input type="password" disabled={!settings.identification.acoustIdEnabled} value={acoustIdApiKey} placeholder={settings.identification.acoustIdApiKeySet ? "Saved" : "Required for fingerprint lookups"} onChange={(event) => setAcoustIdApiKey(event.target.value)} />
              </label>
              <Toggle
                label="Accept unique fingerprint + release matches"
                description="When every track in a folder agrees on one release, identify them without asking."
                checked={settings.identification.autoAcceptUniqueFingerprintMatches}
                onChange={(autoAcceptUniqueFingerprintMatches) => update({ identification: { ...settings.identification, autoAcceptUniqueFingerprintMatches } })}
              />
              <Toggle
                label="Require confirmation before file changes"
                description="Even automatic matches wait in Organize until you confirm them."
                checked={settings.identification.requireReviewBeforeFileChanges}
                onChange={(requireReviewBeforeFileChanges) => update({ identification: { ...settings.identification, requireReviewBeforeFileChanges } })}
              />
            </SettingsCard>

            <SettingsCard
              title="MusicBrainz text search"
              icon={Music2}
              status={settings.musicbrainz.textSearchEnabled ? "On" : "Off"}
              description="For files fingerprinting cannot place, search MusicBrainz by their tags, one album folder at a time. Matches always wait for confirmation."
            >
              <Toggle label="Search MusicBrainz by tags" checked={settings.musicbrainz.textSearchEnabled} onChange={(textSearchEnabled) => update({ musicbrainz: { ...settings.musicbrainz, textSearchEnabled } })} />
              <label>
                MusicBrainz requests per scan
                <input
                  type="number"
                  min={0}
                  max={5000}
                  value={settings.musicbrainz.maxTextLookupsPerScan}
                  onChange={(event) => update({ musicbrainz: { ...settings.musicbrainz, maxTextLookupsPerScan: Number(event.target.value) } })}
                />
                <small>MusicBrainz allows one request per second; results are cached, so later scans are fast.</small>
              </label>
              <Toggle label="Use embedded tags as search hints" checked={settings.identification.useEmbeddedTagsAsHints} onChange={(useEmbeddedTagsAsHints) => update({ identification: { ...settings.identification, useEmbeddedTagsAsHints } })} />
              <Toggle label="Use filenames and folders as search hints" checked={settings.identification.usePathAsHints} onChange={(usePathAsHints) => update({ identification: { ...settings.identification, usePathAsHints } })} />
            </SettingsCard>
          </>
        )}

        {section === "downloads" && <DownloadSettings settings={settings} update={update} />}

        {section === "library" && (
          <SettingsCard title="Library" icon={FolderInput} description="Files are organized as Artist / Artist - Album (Year) / Artist - Album (Year) - 01 - Title.">
            <label>
              Library path
              <input value={settings.naming.libraryPath} onChange={(event) => update({ naming: { ...settings.naming, libraryPath: event.target.value } })} />
            </label>
            <label>
              Recycle bin path
              <input value={settings.naming.recycleBinPath} onChange={(event) => update({ naming: { ...settings.naming, recycleBinPath: event.target.value } })} />
            </label>
            <Toggle label="Daily automatic scan" checked={settings.scan.autoScanEnabled} onChange={(autoScanEnabled) => update({ scan: { ...settings.scan, autoScanEnabled } })} />
            <label>
              Scan time
              <input type="time" disabled={!settings.scan.autoScanEnabled} value={settings.scan.autoScanTime} onChange={(event) => update({ scan: { ...settings.scan, autoScanTime: event.target.value } })} />
            </label>
            <div className="settings-subsection">
              <span className="subsection-label">Empty-folder exclusions</span>
              {settings.cleanup.emptyFolderExclusions.length === 0 ? (
                <span className="muted">No excluded folders</span>
              ) : (
                <div className="settings-list">
                  {settings.cleanup.emptyFolderExclusions.map((relativePath) => (
                    <div className="settings-list-row" key={relativePath}>
                      <span className="path-diff">{relativePath}</span>
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => update({ cleanup: { emptyFolderExclusions: settings.cleanup.emptyFolderExclusions.filter((item) => item !== relativePath) } })}
                      >
                        <Check size={16} />
                        <span>Include again</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SettingsCard>
        )}

        <div className="settings-actions sticky-save-bar">
          <span className="muted">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          <button className="primary-button" type="submit" disabled={busy === "save" || !dirty}>
            {busy === "save" ? <Spinner size={18} /> : <Save size={18} />}
            <span>Save changes</span>
          </button>
        </div>
      </div>
    </form>
  );
}

function DownloadSettings({ settings, update }: { settings: SettingsView; update: (next: Partial<SettingsView>) => void }) {
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const engine = settings.engine;
  const setEngine = (next: Partial<SettingsView["engine"]>) => update({ engine: { ...engine, ...next } });
  const providers = settings.catalog.providers;
  const setProviders = (next: Partial<SettingsView["catalog"]["providers"]>) =>
    update({ catalog: { ...settings.catalog, providers: { ...providers, ...next } } });

  useEffect(() => {
    api<EngineStatus>("/engine/status").then(setStatus).catch(() => undefined);
  }, []);

  const moveSource = (id: CatalogProviderId, direction: -1 | 1) => {
    const order = [...engine.sourcePriority];
    const index = order.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    setEngine({ sourcePriority: order });
  };

  return (
    <>
      <SettingsCard title="Matching" icon={Download} description="Every search result gets a 0–100 score for title, artist, length, and album, with penalties for live, remix, cover, and re-upload versions.">
        <div className="form-row">
          <label>
            Download automatically at or above
            <input type="number" min={50} max={100} value={engine.autoAcceptScore} onChange={(event) => setEngine({ autoAcceptScore: Number(event.target.value) })} />
          </label>
          <label>
            Hold for review at or above
            <input type="number" min={30} max={99} value={engine.reviewScore} onChange={(event) => setEngine({ reviewScore: Number(event.target.value) })} />
          </label>
        </div>
        <p className="supporting-note">Below the review score, a track goes to Wanted and is searched again later.</p>
      </SettingsCard>

      <SettingsCard title="Verification" icon={Shield} description="Checks run on every download before it can enter the library. A failed source is quarantined for that track.">
        <Toggle label="Check length against the release track" checked={engine.verifyDuration} onChange={(verifyDuration) => setEngine({ verifyDuration })} />
        <Toggle
          label="Check the audio fingerprint"
          description={settings.identification.acoustIdEnabled ? "Uses your AcoustID key." : "Needs AcoustID, enabled under Identification."}
          checked={engine.verifyFingerprint}
          onChange={(verifyFingerprint) => setEngine({ verifyFingerprint })}
        />
        <span className="subsection-label">Minimum source bitrate</span>
        <div className="quality-grid">
          {(Object.keys(codecLabels) as QualityCodecFamily[]).map((family) => (
            <label key={family}>
              {codecLabels[family]}
              <span className="input-suffix">
                <input
                  type="number"
                  min={0}
                  max={320}
                  value={settings.quality.minimumBitrateKbps[family]}
                  onChange={(event) => update({ quality: { minimumBitrateKbps: { ...settings.quality.minimumBitrateKbps, [family]: Number(event.target.value) } } })}
                />
                <span>kbps</span>
              </span>
            </label>
          ))}
        </div>
        <p className="supporting-note">These floors also decide which existing tracks appear under Upgrades.</p>
      </SettingsCard>

      <SettingsCard title="Sources" icon={SlidersHorizontal} description="Every enabled source is searched; priority only breaks near-ties in score.">
        <ul className="source-list">
          {engine.sourcePriority.map((id, index) => {
            const source = status?.sources.find((entry) => entry.id === id);
            const enabled = !engine.disabledSources.includes(id);
            return (
              <li key={id}>
                <span className="source-rank">{index + 1}</span>
                <div>
                  <strong>{sourceLabels[id]}</strong>
                  <span className="muted">{source?.message ?? ""}</span>
                </div>
                {source && <Badge tone={source.available ? "success" : "danger"}>{source.available ? "Available" : "Unavailable"}</Badge>}
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) =>
                      setEngine({
                        disabledSources: event.target.checked
                          ? engine.disabledSources.filter((entry) => entry !== id)
                          : [...engine.disabledSources, id]
                      })
                    }
                  />
                  <span>{enabled ? "On" : "Off"}</span>
                </label>
                <button className="icon-button" type="button" title="Move up" disabled={index === 0} onClick={() => moveSource(id, -1)}><ArrowUp size={16} /></button>
                <button className="icon-button" type="button" title="Move down" disabled={index === engine.sourcePriority.length - 1} onClick={() => moveSource(id, 1)}><ArrowDown size={16} /></button>
              </li>
            );
          })}
        </ul>
        <div className="form-row">
          <label>
            Opus quality cap
            <select value={providers.opusQuality} onChange={(event) => setProviders({ opusQuality: Number(event.target.value) as 160 | 192 | 256 })}>
              <option value={160}>160 kbps</option>
              <option value={192}>192 kbps (default)</option>
              <option value={256}>256 kbps</option>
            </select>
          </label>
          <label>
            MP3 fallback
            <select
              value={providers.mp3FallbackEnabled ? providers.mp3FallbackQuality : "off"}
              onChange={(event) =>
                event.target.value === "off"
                  ? setProviders({ mp3FallbackEnabled: false })
                  : setProviders({ mp3FallbackEnabled: true, mp3FallbackQuality: Number(event.target.value) as 192 | 256 | 320 })
              }
            >
              <option value="off">Off</option>
              <option value={192}>192 kbps</option>
              <option value={256}>256 kbps</option>
              <option value={320}>320 kbps (default)</option>
            </select>
          </label>
          <label>
            Parallel downloads
            <select value={providers.maxConcurrentDownloads} onChange={(event) => setProviders({ maxConcurrentDownloads: Number(event.target.value) })}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
        </div>
        <p className="supporting-note">Caps are maximums: lower-bitrate sources keep their original quality instead of being upconverted. YouTube downloads always wait 10 s between tracks and pause 2 min after every 5.</p>
      </SettingsCard>

      <SettingsCard title="Background work" icon={Activity}>
        <Toggle label="Retry Wanted tracks in the background" checked={engine.wantedEnabled} onChange={(wantedEnabled) => setEngine({ wantedEnabled })} />
        <div className="form-row">
          <label>
            Wanted check interval
            <span className="input-suffix">
              <input type="number" min={10} max={1440} value={engine.wantedIntervalMinutes} onChange={(event) => setEngine({ wantedIntervalMinutes: Number(event.target.value) })} />
              <span>minutes</span>
            </span>
          </label>
          <label>
            Check followed artists every
            <span className="input-suffix">
              <input type="number" min={1} max={168} value={engine.followCheckHours} onChange={(event) => setEngine({ followCheckHours: Number(event.target.value) })} />
              <span>hours</span>
            </span>
          </label>
        </div>
        <Toggle
          label="Download new releases from every followed artist automatically"
          description="You can also turn this on for individual artists under Following."
          checked={engine.autoDownloadFollowedReleases}
          onChange={(autoDownloadFollowedReleases) => setEngine({ autoDownloadFollowedReleases })}
        />
      </SettingsCard>
    </>
  );
}

function PasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  const submit = async () => {
    if (newPassword !== confirmPassword) {
      setMessage({ tone: "error", text: "The new passwords do not match." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api("/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setMessage({ tone: "success", text: "Password changed. Other signed-in sessions were signed out." });
    } catch (caught) {
      setMessage({ tone: "error", text: (caught as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard title="Password" icon={KeyRound} description="At least 8 characters. Changing it signs out every other session.">
      <label>
        Current password
        <input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
      </label>
      <div className="form-row">
        <label>
          New password
          <input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        <label>
          Confirm new password
          <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
      </div>
      {message && <p className={message.tone === "error" ? "form-error" : "form-success"}>{message.text}</p>}
      <button className="secondary-button fit" type="button" disabled={busy || !currentPassword || newPassword.length < 8} onClick={() => void submit()}>
        {busy ? <Spinner /> : <KeyRound size={16} />}
        <span>Change password</span>
      </button>
    </SettingsCard>
  );
}

function SettingsCard({
  title,
  icon: Icon,
  status,
  description,
  children
}: {
  title: string;
  icon: typeof Shield;
  status?: string;
  description?: string;
  children: ReactNode;
}) {
  const tone = status === "Connected" || status === "On" ? "success" : status === "Off" ? "neutral" : status ? "warning" : undefined;
  return (
    <fieldset className="panel settings-card">
      <legend>
        <Icon size={18} />
        <span>{title}</span>
        {status && tone && <Badge tone={tone}>{status}</Badge>}
      </legend>
      {description && <p className="settings-description">{description}</p>}
      {children}
    </fieldset>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <span>{label}</span>
        {description && <small>{description}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}
