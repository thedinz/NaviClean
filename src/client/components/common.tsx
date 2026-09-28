import { useState } from "react";
import {
  Check,
  CircleAlert,
  Database,
  FolderX,
  Loader2,
  Settings
} from "lucide-react";
import { appVersion } from "../version";
import { diffText, pluralize } from "../lib/format";

export function LibraryArtwork({
  className,
  icon: Icon,
  label,
  src
}: {
  className: string;
  icon: typeof Database;
  label: string;
  src: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = Boolean(src) && !failed;

  return (
    <span className={`library-thumb ${className}${showImage ? " has-art" : ""}`} aria-hidden="true">
      {showImage ? (
        <img src={src || ""} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <>
          <Icon size={22} />
          <strong>{label}</strong>
        </>
      )}
    </span>
  );
}

export function PathDiff({ value, compareTo }: { value: string; compareTo: string }) {
  return (
    <span className="path-diff">
      {diffText(value, compareTo).map((part, index) =>
        part.changed ? (
          <mark key={`${index}-${part.text}`}>{part.text}</mark>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        )
      )}
    </span>
  );
}

export function ActionProgress({ label }: { label: string }) {
  return (
    <div className="action-progress" role="status" aria-live="polite">
      <div className="action-progress-label">
        <Loader2 className="spin" size={16} />
        <span>{label}</span>
      </div>
      <div className="progress-track" role="progressbar" aria-label={label}>
        <span />
      </div>
    </div>
  );
}

export function DeterminateProgress({ label, value }: { label: string; value: number }) {
  const progress = Math.max(0, Math.min(100, Math.round(value)));

  return (
    <div className="action-progress determinate" role="status" aria-live="polite">
      <div className="action-progress-label">
        <span>{label}</span>
        <strong>{progress}%</strong>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description }: { icon: typeof Database; title: string; description?: string }) {
  return (
    <div className="empty-state">
      <Icon size={24} />
      <strong>{title}</strong>
      {description && <span>{description}</span>}
    </div>
  );
}

export function LibraryAccessError({ messages, onOpenSettings }: { messages: string[]; onOpenSettings: () => void }) {
  return (
    <div className="setup-state error-state" role="alert">
      <FolderX size={28} />
      <strong>Library path is unavailable</strong>
      <span>{messages[0] || "NaviClean could not read the configured library folder."}</span>
      {messages.length > 1 && <span>{messages.length - 1} additional {pluralize("error", messages.length - 1)}</span>}
      <button className="primary-button" type="button" onClick={onOpenSettings}>
        <Settings size={18} />
        <span>Check library settings</span>
      </button>
    </div>
  );
}

export function BrandLogo() {
  return <img className="brand-mark" src="/naviclean.png" alt="" width={42} height={42} />;
}

export function MessageScreen({ title, message }: { title: string; message: string }) {
  const loading = message.toLowerCase().includes("loading");

  return (
    <main className="message-screen">
      {loading ? <Loader2 className="spin" size={24} /> : <CircleAlert size={24} />}
      <h1>{title}</h1>
      <p>{message}</p>
    </main>
  );
}

export function VersionFooter() {
  return (
    <footer className="version-footer">
      <span>Version {appVersion.version}</span>
      <span>Branch {appVersion.branch}</span>
    </footer>
  );
}

export function StatusPill({ active, label }: { active: boolean; label: string }) {
  return <span className={active ? "status-pill active" : "status-pill"}>{label}</span>;
}

export function StagePill({ active, complete, label }: { active: boolean; complete: boolean; label: string }) {
  return <span className={complete ? "stage-pill complete" : active ? "stage-pill active" : "stage-pill"}>{label}</span>;
}
