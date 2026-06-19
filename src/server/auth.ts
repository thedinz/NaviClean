import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { loadSettings } from "./settings.js";

type Session = {
  username: string;
  expiresAt: number;
};

const sessions = new Map<string, Session>();
const cookieName = "naviclean_session";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 14;

export async function login(username: string, password: string) {
  const settings = await loadSettings();

  if (username !== settings.auth.username) {
    return null;
  }

  const valid = await bcrypt.compare(password, settings.auth.passwordHash);
  if (!valid) {
    return null;
  }

  const token = crypto.randomUUID();
  sessions.set(token, {
    username,
    expiresAt: Date.now() + sessionTtlMs
  });
  return token;
}

export function logout(req: Request) {
  const token = readSessionCookie(req);
  if (token) {
    sessions.delete(token);
  }
}

export async function getAuthInfo(req: Request) {
  const settings = await loadSettings();

  if (!settings.auth.enabled) {
    return {
      authEnabled: false,
      authenticated: true,
      username: settings.auth.username
    };
  }

  const session = readSession(req);
  return {
    authEnabled: true,
    authenticated: Boolean(session),
    username: session?.username || null
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const settings = await loadSettings();

  if (!settings.auth.enabled || readSession(req)) {
    next();
    return;
  }

  res.status(401).json({ error: "Authentication required" });
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

function readSession(req: Request) {
  const token = readSessionCookie(req);
  if (!token) {
    return null;
  }

  const session = sessions.get(token);
  if (!session) {
    return null;
  }

  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = Date.now() + sessionTtlMs;
  return session;
}

function readSessionCookie(req: Request) {
  const cookie = req.headers.cookie;
  if (!cookie) {
    return null;
  }

  const cookies = Object.fromEntries(
    cookie.split(";").map((part) => {
      const [name, ...rest] = part.trim().split("=");
      return [decodeURIComponent(name), decodeURIComponent(rest.join("="))];
    })
  );

  return cookies[cookieName] || null;
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
