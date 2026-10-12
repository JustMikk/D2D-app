// Shared HTTP for Google Maps Platform (backend spec §9.1): server-side only, 10-second timeout,
// one retry on 5xx or a network error, and a log line with the API name and latency.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GoogleApiError extends Error {
  constructor(
    readonly api: string,
    readonly status: number,
    message: string,
  ) {
    super(`${api}: ${message}`);
    this.name = "GoogleApiError";
  }
}

export type GoogleHttpOptions = { fetch?: FetchLike; timeoutMs?: number; log?: (line: string) => void };

export async function googleRequest<T>(api: string, url: string, init: RequestInit, options: GoogleHttpOptions = {}): Promise<T> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.log ?? ((line: string) => console.info(line));

  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      log(`[google] ${api} network error after ${Date.now() - started}ms (attempt ${attempt})`);
      if (attempt < 2) continue;
      throw new GoogleApiError(api, 0, error instanceof Error ? error.message : String(error));
    }
    log(`[google] ${api} ${res.status} in ${Date.now() - started}ms`);
    if (res.status >= 500 && attempt < 2) continue;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GoogleApiError(api, res.status, text.slice(0, 500) || res.statusText);
    }
    return (await res.json()) as T;
  }
}
