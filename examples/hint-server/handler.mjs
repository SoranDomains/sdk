/**
 * HTTP surface of the Node hint server, split from server.mjs so it can be
 * tested without RPC access. `getState()` returns the live
 * `{ holders, log, lastLedger, undecodable? }`; `namespace` is the single namespace served;
 * `isAddress` validates a G…/C… strkey (injected so this module has no
 * dependencies and is testable on its own).
 */

export const MAX_PAGE_LIMIT = 100;
export const DEFAULT_PAGE_LIMIT = 40;
const MAX_CURSOR_LEN = 2048;

export function json(res, code, body) {
  const buf = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(buf),
    // Browser wallets are the primary consumers — CORS is part of the hint
    // contract (simple GETs only, so no preflight handling is needed).
    "access-control-allow-origin": "*",
    "x-content-type-options": "nosniff",
  });
  res.end(buf);
}

/**
 * The page shape @sorandomains/lookup's `namesOfPage` requires:
 * `{ holder, names, hasMore, nextCursor, coverage }` with names.length <= limit.
 * Names are sorted so the opaque cursor (the last name served) is stable.
 * Returns `null` for an invalid limit/cursor.
 */
export function byHolderPage(state, namespace, addr, limitParam, cursorParam) {
  let limit = DEFAULT_PAGE_LIMIT;
  if (limitParam !== null && limitParam !== undefined) {
    if (!/^\d{1,3}$/.test(limitParam)) return null;
    limit = Number(limitParam);
    if (limit < 1 || limit > MAX_PAGE_LIMIT) return null;
  }
  let after = null;
  if (cursorParam !== null && cursorParam !== undefined) {
    if (cursorParam.length < 1 || cursorParam.length > MAX_CURSOR_LEN) return null;
    after = cursorParam;
  }
  const all = Object.entries(state.holders)
    .filter(([name, h]) => h === addr && (after === null || name > after))
    .map(([name]) => name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const page = all.slice(0, limit);
  const hasMore = all.length > limit;
  return {
    holder: addr,
    names: page.map((name) => ({ name, namespace, holder: addr })),
    hasMore,
    nextCursor: hasMore ? page[page.length - 1] : null,
    // Honest coverage: this server indexes ONE namespace from a bounded event
    // window plus an optional seed, so it cannot attest completeness.
    coverage: {
      source: "indexed",
      complete: false,
      processedLedger: Number.isSafeInteger(state.lastLedger) && state.lastLedger >= 0 ? state.lastLedger : null,
      headLedger: null,
      gaps: [],
    },
  };
}

export function createHandler(getState, namespace, isAddress) {
  return (req, res) => {
    try {
      route(req, res, getState(), namespace, isAddress);
    } catch {
      // One bad request must never take the process down.
      try {
        if (!res.headersSent) json(res, 400, { error: "bad_request" });
        else res.end();
      } catch {
        /* socket already gone */
      }
    }
  };
}

function route(req, res, state, namespace, isAddress) {
  let url;
  try {
    // A leading `//` (or other malformed target) makes the URL parser throw.
    url = new URL(req.url ?? "/", "http://x");
  } catch {
    return json(res, 400, { error: "bad_url" });
  }
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/healthz") {
    return json(res, 200, {
      ok: true,
      namespace,
      names: Object.keys(state.holders).length,
      lastLedger: state.lastLedger,
      // Events the poller could not decode; they are skipped, not silently lost.
      undecodableEvents: Number.isSafeInteger(state.undecodable) ? state.undecodable : 0,
    });
  }
  if (url.pathname === "/v1/showcase") {
    return json(res, 200, { namespaces: [namespace] });
  }
  // /v1/names/by-holder/:address?limit=&cursor=
  if (parts.length === 4 && parts[0] === "v1" && parts[1] === "names" && parts[2] === "by-holder") {
    const addr = parts[3];
    if (!isAddress(addr)) {
      return json(res, 400, { error: "bad_address" });
    }
    const page = byHolderPage(state, namespace, addr, url.searchParams.get("limit"), url.searchParams.get("cursor"));
    if (!page) return json(res, 400, { error: "bad_page" });
    return json(res, 200, page);
  }
  // /v1/reverse/:address
  if (parts.length === 3 && parts[0] === "v1" && parts[1] === "reverse") {
    const addr = parts[2];
    const found = Object.entries(state.holders).find(([, h]) => h === addr);
    if (!found) return json(res, 404, { error: "no_name" });
    return json(res, 200, { name: found[0] });
  }
  // /v1/names/:ns/:label/history
  if (parts.length === 5 && parts[0] === "v1" && parts[1] === "names" && parts[4] === "history") {
    const name = `${parts[3]}.${parts[2]}`.toLowerCase();
    const events = state.log[name];
    if (!events && !(name in state.holders)) return json(res, 404, { error: "name_not_found", name });
    const first = events?.find((e) => e.action === "issued");
    return json(res, 200, {
      name,
      // Only what THIS server has witnessed — a from-latest start or seeded
      // name has no issuance event; the platform indexer is the fuller source.
      issuedAt: first?.at ?? "",
      issuedLedger: first?.ledger ?? 0,
      events: [...(events ?? [])].reverse(),
    });
  }
  return json(res, 404, { error: "not_found" });
}
