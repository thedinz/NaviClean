import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { DownloadJobSummary, EngineStatus, ScanStatus, ServerEvent } from "../../shared/types";
import { api } from "../api";

export type LiveState = {
  connected: boolean;
  scan: ScanStatus | null;
  engine: EngineStatus | null;
  jobs: Record<string, DownloadJobSummary>;
  catalogVersion: number;
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  refreshEngine: () => Promise<void>;
};

export const LiveContext = createContext<LiveState | null>(null);

export function useLive() {
  const value = useContext(LiveContext);
  if (!value) {
    throw new Error("useLive must be used inside LiveProvider state.");
  }
  return value;
}

/** Subscribes to a live event type for the lifetime of the calling component. */
export function useLiveEvent(listener: (event: ServerEvent) => void) {
  const { subscribe } = useLive();
  const latest = useRef(listener);
  latest.current = listener;
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe]);
}

/**
 * Keeps one EventSource open to /api/events. Scan progress, download jobs, and engine
 * counters arrive as they change; when the stream drops it reconnects with backoff and
 * falls back to occasional polling so the UI never goes stale.
 */
export function useLiveState(enabled: boolean): LiveState {
  const [connected, setConnected] = useState(false);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [jobs, setJobs] = useState<Record<string, DownloadJobSummary>>({});
  const [catalogVersion, setCatalogVersion] = useState(0);
  const listeners = useRef(new Set<(event: ServerEvent) => void>());

  const refreshEngine = async () => {
    try {
      setEngine(await api<EngineStatus>("/engine/status"));
    } catch {
      // Counters are best-effort; the next event or poll will update them.
    }
  };

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let source: EventSource | null = null;
    let retryDelay = 1000;
    let retryTimer: number | undefined;
    let pollTimer: number | undefined;
    let disposed = false;

    const handle = (event: ServerEvent) => {
      if (event.type === "scan") setScan(event.status);
      if (event.type === "engine") setEngine(event.status);
      if (event.type === "download-job") setJobs((current) => ({ ...current, [event.job.id]: event.job }));
      if (event.type === "catalog-changed") setCatalogVersion((current) => current + 1);
      for (const listener of listeners.current) {
        listener(event);
      }
    };

    const poll = async () => {
      try {
        setScan(await api<ScanStatus>("/scan/status"));
      } catch {
        // Offline; keep trying.
      }
      await refreshEngine();
    };

    const connect = () => {
      if (disposed) return;
      const base = document.baseURI.endsWith("/") ? document.baseURI : `${document.baseURI}/`;
      source = new EventSource(new URL("api/events", base).toString(), { withCredentials: true });
      source.onopen = () => {
        retryDelay = 1000;
        setConnected(true);
        window.clearInterval(pollTimer);
        pollTimer = undefined;
      };
      source.onmessage = (message) => {
        try {
          handle(JSON.parse(message.data) as ServerEvent);
        } catch {
          // Ignore malformed frames.
        }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        if (!pollTimer) {
          pollTimer = window.setInterval(() => void poll(), 5000);
        }
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(30_000, retryDelay * 2);
      };
    };

    void poll();
    connect();

    return () => {
      disposed = true;
      source?.close();
      window.clearTimeout(retryTimer);
      window.clearInterval(pollTimer);
    };
  }, [enabled]);

  const subscribe = useCallback((listener: (event: ServerEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  return { connected, scan, engine, jobs, catalogVersion, refreshEngine, subscribe };
}
