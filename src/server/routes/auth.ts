import { Router } from "express";
import type { AuthInfo } from "../../shared/types.js";
import {
  changePassword,
  clearSessionCookie,
  getAuthInfo,
  login,
  LoginThrottledError,
  logout,
  PasswordChangeError,
  setSessionCookie
} from "../auth.js";
import { advancedDiagnosticsEnabled } from "../diagnostics.js";
import { HttpError, route } from "../http.js";
import { loadSettings } from "../settings.js";

/** Routes that must stay reachable without a session. */
export const authRouter = Router();

authRouter.get("/auth/me", route(async (req, res) => {
  res.json(await getAuthInfo(req));
}));

authRouter.post("/auth/login", route(async (req, res) => {
  const username = String(req.body?.username || "");
  let token: string | null;

  try {
    token = await login(username, String(req.body?.password || ""), req.ip ?? "");
  } catch (error) {
    if (error instanceof LoginThrottledError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      throw new HttpError(429, error.message);
    }
    throw error;
  }

  if (!token) {
    throw new HttpError(401, "Invalid username or password");
  }

  setSessionCookie(req, res, token);
  const settings = await loadSettings();
  res.json({
    advancedDiagnosticsEnabled: advancedDiagnosticsEnabled(),
    authEnabled: true,
    authenticated: true,
    mustChangePassword: Boolean(settings.auth.mustChangePassword),
    username
  } satisfies AuthInfo);
}));

authRouter.post("/auth/logout", route((req, res) => {
  logout(req);
  clearSessionCookie(req, res);
  res.json({ ok: true });
}));

authRouter.post("/auth/password", route(async (req, res) => {
  try {
    await changePassword(req, String(req.body?.currentPassword || ""), String(req.body?.newPassword || ""));
  } catch (error) {
    if (error instanceof PasswordChangeError) {
      throw new HttpError(error.status, error.message);
    }
    throw error;
  }

  res.json(await getAuthInfo(req));
}));
