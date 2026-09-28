import { useEffect, useState } from "react";

export type PageId =
  | "dashboard"
  | "library"
  | "organize"
  | "duplicates"
  | "upgrades"
  | "discover"
  | "downloads"
  | "following"
  | "cleanup"
  | "convert"
  | "trash"
  | "diagnostics"
  | "settings"
  | "guide";

export type Route = { page: PageId; params: URLSearchParams };

const pageIds = new Set<PageId>([
  "dashboard", "library", "organize", "duplicates", "upgrades", "discover", "downloads",
  "following", "cleanup", "convert", "trash", "diagnostics", "settings", "guide"
]);

/** Routes live in the URL hash (#/discover?artist=…) so refreshes and the back button keep your place. */
export function parseRoute(hash = window.location.hash): Route {
  const [pathPart, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const page = pathPart as PageId;
  return { page: pageIds.has(page) ? page : "dashboard", params: new URLSearchParams(query) };
}

export function routeHref(page: PageId, params: Record<string, string | null | undefined> = {}) {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1]))
  ).toString();
  return `#/${page}${query ? `?${query}` : ""}`;
}

export function navigate(page: PageId, params: Record<string, string | null | undefined> = {}) {
  const next = routeHref(page, params);
  if (window.location.hash !== next) {
    window.location.hash = next;
  }
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute());

  useEffect(() => {
    const update = () => setRoute(parseRoute());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  return route;
}
