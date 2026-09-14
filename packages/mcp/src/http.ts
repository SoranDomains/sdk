/** HTTP refusal is distinct from an interrupted or undecodable response. */
export class ApiHttpError extends Error {
  readonly body: Record<string, unknown> | null;
  constructor(readonly status: number, raw: string, message: string) {
    super(message);
    this.name = "ApiHttpError";
    let body: unknown;
    try { body = JSON.parse(raw); } catch { body = null; }
    this.body = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  }
}
/** Bounded fetch for API tools: 10s abort, ok-check, 128KB cap, no redirects.
 *  GET by default; pass `body` for a POST, `token` for a Bearer header. */
export async function boundedJson(
  url: string,
  body?: unknown,
  token?: string,
  expectedNamespace?: string,
): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    if (expectedNamespace) headers["X-Soran-Namespace"] = expectedNamespace;
    // redirect "manual" + status check: workerd doesn't implement "error",
    // and a redirect from the API host is treated as failure either way.
    const res = await fetch(url, {
      method: body !== undefined ? "POST" : "GET",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      redirect: "manual",
    });
    const raw = await res.text();
    if (raw.length > 131_072) throw new Error(`${url}: response too large`);
    if (res.status >= 300) {
      let detail = raw.slice(0, 200);
      try {
        const j = JSON.parse(raw);
        detail = j.detail ?? j.error ?? detail;
      } catch {
        /* keep raw slice */
      }
      throw new ApiHttpError(res.status, raw, `${url.split("__")[0].replace(/https?:\/\/[^/]+/, "")}: HTTP ${res.status} — ${detail}`);
    }
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}
