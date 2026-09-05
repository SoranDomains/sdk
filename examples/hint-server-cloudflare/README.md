# Hint server on Cloudflare Workers

This historical example exposes the earlier, unpaginated discovery format. It does
not implement the cursor and coverage contract required for complete holdings in
lookup 0.5.0. Use a compatible current indexer for `namesOfPage` and do not treat
this example's holdings response as a complete inventory.

The [self-hostable hint server](../hint-server/), adapted to Cloudflare — with
**zero dependencies**: Soroban RPC's `xdrFormat: "json"` mode returns events
as plain JSON, so no Stellar SDK and no XDR decoding is needed at the edge.

Same trust model as ever: hints are discovery, not truth. The lookup SDK
verifies every candidate on chain, so this Worker can be stale or wrong
without safety consequences — which is exactly why it fits a 200-line Worker.

## How it maps to the platform

| Node example | Worker edition |
| --- | --- |
| poll loop (`setInterval`) | **Cron Trigger** (every minute) |
| JSON state file | **KV** (`HINT_KV`, key `state`) |
| `@stellar/stellar-sdk` | nothing — RPC JSON mode + `fetch` |
| Registrar discovered on chain | `SORAN_REGISTRAR_ID` var (one-time lookup) |

**Worker, not Pages:** Pages Functions can serve the HTTP side but have no
cron, so the index would never update. Deploy this as a Worker.

## Deploy

```bash
npx wrangler kv namespace create HINT_KV     # paste the id into wrangler.toml
# set SORAN_NAMESPACE + SORAN_REGISTRAR_ID in wrangler.toml [vars]
npx wrangler deploy
```

Get your Registrar id once: `await new SoranOwner({...}).registrarOf("acme")`,
or from your console's namespace page. Then point the SDK at the Worker URL:

```ts
const soran = new Soran({ hintUrl: "https://soran-hint-server.<you>.workers.dev" });
```

## Local development (no account needed)

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*"   # run one indexing pass
curl  http://localhost:8787/healthz
```

## Seeding older names

RPC nodes retain a limited event window; names issued before it need a
one-time seed. Put a JSON array under the KV key `seed` — as the namespace
owner you have this list (your `issueBatch` outcomes are exactly this shape):

```bash
npx wrangler kv key put --binding HINT_KV seed \
  '[{"name":"alice.acme","holder":"G..."}]'
```

The seed is re-merged on every cron run (chain events always win), so it
works whenever you add it. Stale entries are harmless — the SDK's on-chain
verification drops anything that no longer holds.

## Notes

- **Local dev fetch quirk:** on some machines, local `wrangler dev` (workerd)
  cannot reach specific hosts that curl reaches fine. If the poll fails
  locally with `internal error; reference = …`, point `SORAN_RPC_URL` at any
  reachable RPC (or a tiny local forwarder) for testing — deployed Workers
  fetch from Cloudflare's edge and are unaffected.

- **Free-tier friendly by design:** KV writes happen only when state
  actually changed (an idle namespace writes ~0/day, so a 1-minute cron
  stays inside the 1,000-writes/day free quota), and public reads are
  edge-cached for 30s, so request floods hit the cache instead of billing
  KV reads and CPU. A very busy namespace (thousands of event batches/day)
  should move to the paid tier or a slower cron.
- **Self-healing poller:** a cursor that falls out of the RPC's event
  retention (after long downtime) re-anchors at the current ledger and
  counts the gap — check `gaps` and `lastError` on `/healthz`, and reseed
  if the gap matters. `/healthz` reports `ok: false` while polling fails.
- **Bounded state:** the index refuses growth past 50k names (`full: true`
  on `/healthz`) and clamps every RPC-supplied field, so neither time nor a
  hostile RPC can push the KV value toward its 25 MiB cap.
- KV is eventually consistent at the edge (~seconds): a just-issued name may
  take a poll cycle plus propagation to appear. Discovery-grade, by design.
- Event application is idempotent and kept in ledger order, so cron overlap
  or a cursor replay never double-counts or disorders history.
- The per-run page cap keeps each invocation well under Workers' subrequest
  limit; a large backfill simply spans a few cron runs.
