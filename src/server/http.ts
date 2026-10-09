import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getActiveAudioConvertJob } from "./converter.js";
import { advancedDiagnosticsEnabled } from "./diagnostics.js";
import { withLibraryLock } from "./library-lock.js";
import { isScanRunning } from "./scan-service.js";

type Handler = (req: Request, res: Response) => Promise<void> | void;

/** An error that maps to a specific HTTP status; `body` fields are merged into the JSON reply. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/** Wraps a read-only handler so thrown or rejected errors reach the error handler. */
export function route(handler: Handler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(next);
  };
}

/**
 * Wraps a handler that changes library files or catalog state: it is refused while a scan or
 * conversion is running, and otherwise runs under the library lock so writers never interleave.
 */
export function mutation(handler: Handler): RequestHandler {
  return route(async (req, res) => {
    assertLibraryIdle();
    await withLibraryLock(async () => {
      // Re-check: a scan may have started while this request waited for the lock.
      assertLibraryIdle();
      await handler(req, res);
    });
  });
}

export function assertLibraryIdle() {
  if (isScanRunning()) {
    throw new HttpError(409, "A library scan is running. Wait for it to finish, then try again.");
  }

  if (getActiveAudioConvertJob()) {
    throw new HttpError(409, "An audio conversion is running. Wait for it to finish, then try again.");
  }
}

/** Reads a request field as a list of non-empty strings. */
export function stringList(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/** Reads a request field as a list of strings, or undefined when it is not an array. */
export function optionalStringList(value: unknown) {
  return Array.isArray(value) ? value.map(String) : undefined;
}

export function requireString(value: unknown, message: string) {
  const text = String(value ?? "").trim();

  if (!text) {
    throw new HttpError(400, message);
  }

  return text;
}

export function requireAdvancedDiagnostics(_req: Request, res: Response, next: NextFunction) {
  if (advancedDiagnosticsEnabled()) {
    next();
    return;
  }

  res.status(404).json({ error: "Not found" });
}

export function errorHandler(error: Error, _req: Request, res: Response, _next: NextFunction) {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message, ...error.body });
    return;
  }

  res.status(500).json({ error: error.message });
}

export function clampInteger(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Reads a request field as a non-empty list of non-empty strings, or fails with 400. */
export function requireList(value: unknown, message: string) {
  const list = stringList(value);

  if (list.length === 0) {
    throw new HttpError(400, message);
  }

  return list;
}
