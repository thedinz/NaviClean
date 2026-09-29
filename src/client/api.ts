export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown
  ) {
    super(message);
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);

  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(apiUrl(path), {
    ...options,
    cache: options.cache ?? "no-store",
    headers,
    credentials: "include"
  });

  if (!response.ok) {
    let message = response.statusText;
    let body: unknown = null;
    try {
      body = await response.json();
      message = (body as { error?: string }).error || message;
    } catch {
      // Keep the HTTP status text.
    }
    throw new ApiError(message, response.status, body);
  }

  return response.json() as Promise<T>;
}

function apiUrl(path: string) {
  const base = document.baseURI.endsWith("/") ? document.baseURI : `${document.baseURI}/`;
  return new URL(`api/${path.replace(/^\/+/, "")}`, base).toString();
}
