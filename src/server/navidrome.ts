import crypto from "node:crypto";
import type { PrivateSettings } from "./settings.js";

export async function testNavidromeConnection(
  settings: PrivateSettings,
  override?: { baseUrl?: string; username?: string; password?: string }
) {
  const baseUrl = (override?.baseUrl || settings.navidrome.baseUrl).replace(/\/+$/, "");
  const username = override?.username || settings.navidrome.username;
  const password = override?.password || settings.navidrome.password;

  if (!baseUrl || !username || !password) {
    return {
      ok: false,
      message: "Navidrome URL, username, and password are required"
    };
  }

  const salt = crypto.randomBytes(8).toString("hex");
  const token = crypto.createHash("md5").update(`${password}${salt}`).digest("hex");
  const url = new URL("rest/ping.view", `${baseUrl}/`);
  url.searchParams.set("u", username);
  url.searchParams.set("t", token);
  url.searchParams.set("s", salt);
  url.searchParams.set("v", "1.16.1");
  url.searchParams.set("c", "NaviClean");
  url.searchParams.set("f", "json");

  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    return {
      ok: false,
      message: `HTTP ${response.status} from Navidrome`
    };
  }

  const body = (await response.json()) as {
    "subsonic-response"?: {
      status?: string;
      version?: string;
      error?: {
        message?: string;
      };
    };
  };
  const subsonic = body["subsonic-response"];

  if (subsonic?.status === "ok") {
    return {
      ok: true,
      message: `Connected to Subsonic API ${subsonic.version || "1.16.1"}`
    };
  }

  return {
    ok: false,
    message: subsonic?.error?.message || "Navidrome rejected the connection"
  };
}

