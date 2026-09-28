import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "../shared/types.js";
import { execute, queryOne } from "./db.js";
import { advancedDiagnosticsEnabled } from "./diagnostics.js";
import { loadSettings, passwordProblem, saveSettings } from "./settings.js";

const cookieName = "naviclean_session";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 14;
// Sliding expiry is only persisted once this much of the window has elapsed, to avoid a write per request.
const sessionRefreshIntervalMs = 1000 * 60 * 60;
const loginWindowMs = 1000 * 60 * 15;
const maxLoginFailures = 5;
const loginFailures = new Map<string, number[]>();

export class LoginThrottledError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`);
  }
}

export async function login(username: string, password: string, clientKey = "") {
  const throttleKey = `${clientKey}|${username.toLowerCase()}`;
  const retryAfter = loginRetryAfterSeconds(throttleKey);

  if (retryAfter > 0) {
    throw new LoginThrottledError(retryAfter);
  }

  const settings = await loadSettings();
  const valid = username === settings.auth.username && (await bcrypt.compare(password, settings.auth.passwordHash));

  if (!valid) {
    recordLoginFailure(throttleKey);
    return null;
  }

  loginFailures.delete(throttleKey);
  return createSession(username);
}

export function logout(req: Request) {
  const token = readSessionCookie(req);
  if (token) {
    execute("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
  }
}

export async function getAuthInfo(req: Request): Promise<AuthInfo> {
  const settings = await loadSettings();

  if (!settings.auth.enabled) {
    return {
      advancedDiagnosticsEnabled: advancedDiagnosticsEnabled(),
      authEnabled: false,
      authenticated: true,
      mustChangePassword: false,
      username: settings.auth.username
    };
  }

  const session = readSession(req);
  return {
    advancedDiagnosticsEnabled: advancedDiagnosticsEnabled(),
    authEnabled: true,
    authenticated: Boolean(session),
    mustChangePassword: Boolean(session && settings.auth.mustChangePassword),
    username: session?.username || null
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const settings = await loadSettings();

  if (!settings.auth.enabled) {
    next();
    return;
  }

  if (!readSession(req)) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (settings.auth.mustChangePassword) {
    res.status(403).json({
      code: "password-change-required",
      error: "Change the default password before using NaviClean."
    });
    return;
  }

  next();
}

/** Changes the sign-in password after verifying the current one, and signs out every other session. */
export async function changePassword(req: Request, currentPassword: string, newPassword: string) {
  const settings = await loadSettings();
  const session = settings.auth.enabled ? readSession(req) : null;

  if (settings.auth.enabled && !session) {
    throw new PasswordChangeError(401, "Authentication required");
  }

  if (!(await bcrypt.compare(currentPassword, settings.auth.passwordHash))) {
    throw new PasswordChangeError(400, "The current password is incorrect.");
  }

  const problem = passwordProblem(newPassword, settings.auth.username);
  if (problem) {
    throw new PasswordChangeError(400, problem);
  }

  settings.auth.passwordHash = await bcrypt.hash(newPassword, 12);
  settings.auth.mustChangePassword = false;
  await saveSettings(settings);

  const currentToken = readSessionCookie(req);
  execute("DELETE FROM sessions WHERE token_hash != ?", currentToken ? hashToken(currentToken) : "");
}

export class PasswordChangeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Flags installs still using the shipped admin/admin credentials so the UI can require a change. */
export async function flagDefaultPassword() {
  const settings = await loadSettings();

  if (settings.auth.mustChangePassword || !settings.auth.enabled) {
    return;
  }

  if (await bcrypt.compare("admin", settings.auth.passwordHash)) {
    settings.auth.mustChangePassword = true;
    await saveSettings(settings);
  }
}

export function pruneExpiredSessions() {
  execute("DELETE FROM sessions WHERE expires_at < ?", Date.now());
}

export function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(cookieName, token, {
    httpOnly: true,
    sameSite: sameSiteCookieMode(),
    secure: secureCookieMode(req),
    maxAge: sessionTtlMs,
    path: "/"
  });
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(cookieName, {
    path: "/",
    sameSite: sameSiteCookieMode(),
    secure: secureCookieMode(req)
  });
}

function createSession(username: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  execute(
    "INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)",
    hashToken(token),
    username,
    now,
    now + sessionTtlMs
  );
  return token;
}

function readSession(req: Request) {
  const token = readSessionCookie(req);
  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);
  const session = queryOne<{ username: string; expires_at: number }>(
    "SELECT username, expires_at FROM sessions WHERE token_hash = ?",
    tokenHash
  );
  if (!session) {
    return null;
  }

  const now = Date.now();
  if (session.expires_at < now) {
    execute("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
    return null;
  }

  if (session.expires_at - now < sessionTtlMs - sessionRefreshIntervalMs) {
    execute("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", now + sessionTtlMs, tokenHash);
  }

  return { username: session.username };
}

function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function loginRetryAfterSeconds(key: string) {
  const now = Date.now();
  const recent = (loginFailures.get(key) ?? []).filter((at) => now - at < loginWindowMs);
  loginFailures.set(key, recent);

  if (recent.length < maxLoginFailures) {
    return 0;
  }

  return Math.max(1, Math.ceil((recent[0] + loginWindowMs - now) / 1000));
}

function recordLoginFailure(key: string) {
  const failures = loginFailures.get(key) ?? [];
  failures.push(Date.now());
  loginFailures.set(key, failures.slice(-maxLoginFailures));
}

function readSessionCookie(req: Request) {
  const cookie = req.headers.cookie;
  if (!cookie) {
    return null;
  }

  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    try {
      if (decodeURIComponent(name) === cookieName) {
        return decodeURIComponent(rest.join("=")) || null;
      }
    } catch {
      // Ignore malformed cookies from other applications on the same host.
    }
  }

  return null;
}

function sameSiteCookieMode() {
  const value = (process.env.NAVICLEAN_COOKIE_SAMESITE || "lax").toLowerCase();

  if (value === "none" || value === "strict" || value === "lax") {
    return value;
  }

  return "lax";
}

function secureCookieMode(req: Request) {
  const value = (process.env.NAVICLEAN_SECURE_COOKIES || "auto").toLowerCase();

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return req.secure || forwardedProto(req) === "https" || sameSiteCookieMode() === "none";
}

function forwardedProto(req: Request) {
  return String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
}
