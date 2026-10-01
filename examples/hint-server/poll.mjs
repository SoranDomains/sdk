/**
 * Polling core of the Node hint server, split from server.mjs (like handler.mjs)
 * so it can be tested without RPC access. It has no dependencies: the Stellar
 * SDK's XDR decoder and the holder-event logic are injected by server.mjs.
 */

/** What the RPC says when a cursor or start ledger has aged out of its event-retention window. */
const RETENTION_RE = /ledger range:\s*(\d+)\s*[-–]\s*(\d+)/i;
export function isRetentionError(error) {
  return RETENTION_RE.test(String(error?.message ?? error));
}

/**
 * After a failed poll: drop the cursor only when the RPC says it fell out of
 * its retention window (events in the gap are then unrecoverable, so follow
 * from the current ledger). Any other failure (network blip, HTTP 5xx, a parse
 * error) keeps the cursor and is simply retried, so it can never silently skip
 * the events since the last good poll.
 */
export function recoverFromPollError(state, error) {
  if (state.cursor && isRetentionError(error)) {
    state.cursor = null;
    return "reanchored";
  }
  return "retry";
}

/** Decoder for raw `getEvents` entries: first topic (the event kind) and the value, as native JS. */
export function createDecoder({ xdr, scValToNative }) {
  return (raw) => ({
    kind: scValToNative(xdr.ScVal.fromXDR(raw.topic[0], "base64")),
    data: scValToNative(xdr.ScVal.fromXDR(raw.value, "base64")),
    ledger: raw.ledger,
    txHash: raw.txHash,
    at: raw.ledgerClosedAt,
  });
}

/**
 * Decode a raw page one event at a time. An event whose XDR cannot be decoded
 * (for example a value arm this SDK build does not know) is reported, never
 * allowed to fail the page: the SDK's own page parser throws for the whole page,
 * which would wedge the cursor on that page forever.
 */
export function decodePage(events, decode) {
  const decoded = [];
  const undecodable = [];
  for (const raw of Array.isArray(events) ? events : []) {
    try {
      decoded.push(decode(raw));
    } catch (error) {
      undecodable.push({
        id: String(raw?.id ?? "").slice(0, 64),
        ledger: Number.isSafeInteger(raw?.ledger) ? raw.ledger : null,
        reason: String(error?.message ?? error).slice(0, 120),
      });
    }
  }
  return { decoded, undecodable };
}

/** Undecodable events are counted in state (and /healthz) instead of vanishing; the last few are kept for diagnosis. */
function surface(state, undecodable) {
  state.undecodable = (state.undecodable ?? 0) + undecodable.length;
  state.lastUndecodable = [...(state.lastUndecodable ?? []), ...undecodable].slice(-5);
  console.error(`skipped ${undecodable.length} undecodable event(s), e.g. ${undecodable[0].id} @ ledger ${undecodable[0].ledger} (${undecodable[0].reason})`);
}

/**
 * Drain the events since the persisted cursor. `rpc.getEvents` returns the RPC's
 * RAW response (base64 XDR); `startLedger` is the configured backfill start (0 =
 * follow from the current ledger). The cursor is persisted after each page and
 * a failure propagates with it intact (see recoverFromPollError).
 */
export async function pollOnce({ rpc, filters, state, persist, decode, apply, startLedger = 0, pageLimit = 100 }) {
  let request;
  if (state.cursor) request = { filters, cursor: state.cursor, limit: pageLimit };
  else request = { filters, startLedger: startLedger > 0 ? startLedger : (await rpc.getLatestLedger()).sequence, limit: pageLimit };
  for (;;) {
    const page = await rpc.getEvents(request);
    const { decoded, undecodable } = decodePage(page.events, decode);
    if (undecodable.length) surface(state, undecodable);
    for (const ev of decoded) {
      try {
        apply(ev.kind, ev.data, ev.ledger, ev.txHash, ev.at);
        state.lastLedger = ev.ledger;
      } catch {
        /* not an event we understand — skip */
      }
    }
    state.cursor = page.cursor ?? state.cursor;
    persist();
    if (!page.events || page.events.length < pageLimit) break;
    request = { filters, cursor: page.cursor, limit: pageLimit };
  }
}
