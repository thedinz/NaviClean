import { Disc3, Loader2, UserRound } from "lucide-react";
import { useState, type ReactNode } from "react";

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label
}: {
  tabs: Array<{ id: T; label: string; count?: number | null; tone?: "attention" }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          className={value === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {typeof tab.count === "number" && tab.count > 0 && (
            <span className={`tab-count ${tab.tone === "attention" ? "attention" : ""}`}>{tab.count.toLocaleString()}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Square cover or round artist image with a lettered fallback when artwork is missing. */
export function Artwork({
  src,
  label,
  kind = "album",
  size = "md"
}: {
  src: string | null | undefined;
  label: string;
  kind?: "album" | "artist";
  size?: "sm" | "md" | "lg" | "fill";
}) {
  const [failed, setFailed] = useState(false);
  const Icon = kind === "artist" ? UserRound : Disc3;
  const initials = label
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

  return (
    <span className={`artwork artwork-${kind} artwork-${size}`} aria-hidden="true">
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="artwork-fallback">
          <Icon size={size === "sm" ? 16 : 22} />
          {size !== "sm" && initials && <strong>{initials}</strong>}
        </span>
      )}
    </span>
  );
}

export function Badge({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 className="spin" size={size} aria-hidden="true" />;
}

export function Section({
  title,
  description,
  actions,
  children,
  className = ""
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel section ${className}`}>
      {(title || actions) && (
        <header className="section-header">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="section-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
  onClick
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "attention" | "good";
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </>
  );

  return onClick ? (
    <button type="button" className={`stat ${tone ?? ""}`} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={`stat ${tone ?? ""}`}>{content}</div>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const percent = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={label}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

export function RightsConfirmation({
  checked,
  onChange,
  disabled
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="rights-confirmation">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>I am authorized to download these tracks. NaviClean paces requests, but providers can still rate-limit bulk downloads.</span>
    </label>
  );
}
