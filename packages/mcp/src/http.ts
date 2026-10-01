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
/** Plain http is acceptable only to a node on this machine. */
const LOCAL_HTTP = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;
export const isLocalHttp = (url: string): boolean => LOCAL_HTTP.test(url);
/** True when the URL's authority carries a username or password (`https://user:pass@host`). Parsed the way fetch parses it,
 *  so no spelling slips past a pattern; a URL that will not parse is judged on its authority text instead. */
export function hasUrlCredentials(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.username !== "" || parsed.password !== "";
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url);
  }
}
/** An API base may be https, or plain http to a local host, and never carries credentials in the URL (fetch refuses such a
 *  URL and its error echoes it, secret included). Anything else would expose the session token and sign-in signature to the network path. */
export const isSecureApiUrl = (url: string): boolean => (/^https:\/\/[^/?#@\s]/i.test(url) || isLocalHttp(url)) && !hasUrlCredentials(url);
const MAX_BODY_BYTES = 131_072;
/** Read a body as text, aborting as soon as the byte cap is exceeded (never buffers an unbounded response). */
async function readCapped(res: Response, url: string): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new Error(`${url}: response too large`);
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${url}: response too large`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}
/** Bounded fetch for API tools: 10s abort, ok-check, 128KB cap, no redirects.
 *  GET by default; pass `body` for a POST, `token` for a Bearer header. */
export async function boundedJson(
  url: string,
  body?: unknown,
  token?: string,
  expectedNamespace?: string,
): Promise<unknown> {
  // Refused before fetch, whose own error (and every message below) would echo a URL with a username or password.
  if (hasUrlCredentials(url)) throw new Error("refusing a URL that contains a username or password");
  // Defence in depth behind normalizeHintUrl: credentials and signed data
  // (any request with a token or a body) never leave over plain http.
  if ((token || body !== undefined) && !isSecureApiUrl(url)) throw new Error(`${url.replace(/^(\w+:\/\/[^/]*).*$/, "$1")}: refusing to send credentials or signed data over plain http`);
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
    const raw = await readCapped(res, url);
    if (res.status >= 300) {
      let detail = raw.slice(0, 200);
      try {
        const j = JSON.parse(raw);
        const found = j?.detail ?? j?.error;
        if (typeof found === "string") detail = found;
      } catch {
        /* keep raw slice */
      }
      detail = detail.slice(0, 200);
      throw new ApiHttpError(res.status, raw, `${url.split("__")[0].replace(/https?:\/\/[^/]+/, "")}: HTTP ${res.status} — ${detail}`);
    }
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}
