# Self-hosted hint server

This historical example exposes the earlier, unpaginated discovery format. It does
not implement the cursor and coverage contract required for complete holdings in
lookup 0.5.1. Use a compatible current indexer for `namesOfPage` and do not treat
this example's holdings response as a complete inventory.

A complete, self-hostable hint server for one namespace in a single file —
the discovery source `@sorandomains/lookup` uses as its `hintUrl`.

## Why you can run this yourself

The hint role is deliberately **low-stakes by design**: the SDK re-verifies
every candidate on chain (`namesOf` checks the Registrar's `holder_of_node`,
reverse answers are contract-verified), so a hint can hide a name by omission
but can **never forge one**. That's why this needs no database, no auth, and
no uptime guarantees — a JSON file and an event poller are genuinely enough.
If your hint server is down, resolution keeps working; only discovery
convenience degrades.

## Run it

```bash
npm install
SORAN_NAMESPACE=acme node server.mjs
```

Then point the SDK at it:

```ts
const soran = new Soran({ hintUrl: "http://localhost:8787" });
await soran.namesOf("G…WALLET"); // discovered here, verified on chain
```

It discovers your Registrar from the Registry, follows its `issued` /
`reclaimed` / `transfer` events (cursor-persisted — restarts resume where
they left off), and serves:

| Endpoint | Serves |
| --- | --- |
| `/v1/names/by-holder/:address` | `namesOf` discovery (SDK verifies each candidate on chain) |
| `/v1/reverse/:address` | reverse candidate hint |
| `/v1/showcase` | the namespace list for `reverseLookup` |
| `/v1/names/:ns/:label/history` | lifecycle timeline (informational — only events this server has witnessed) |
| `/healthz` | name count + last indexed ledger |

## Bootstrapping older names

RPC nodes retain a limited event window (commonly 24h–7d), so names issued
before that window won't appear from events alone. Two remedies:

- **`seed.json`** — `[{ "name": "alice.acme", "holder": "G…" }, …]`. As the
  namespace owner you already have this list: you issued every name, and
  `@sorandomains/owner`'s `issueBatch` outcomes are exactly this shape. Stale
  seeds are harmless — the SDK's chain verification silently drops anything
  that no longer holds.
- **Start on day one** of a new namespace and the poller never misses an
  event. `SORAN_START_LEDGER` backfills from a specific ledger within your
  RPC's retention.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `SORAN_NAMESPACE` | *(required)* | your namespace label |
| `SORAN_REGISTRAR_ID` | discovered | skip Registry discovery |
| `SORAN_RPC_URL` | testnet public RPC | any Soroban RPC you trust |
| `SORAN_REGISTRY_ID` / `SORAN_PASSPHRASE` | testnet preset | other deployments |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | bind `0.0.0.0` only behind a reverse proxy |
| `SORAN_DATA_FILE` | `./hint-state.json` | persisted index + cursor |
| `SORAN_SEED_FILE` | `./seed.json` | optional bootstrap list |
| `SORAN_POLL_MS` | `10000` | event poll interval |
| `SORAN_START_LEDGER` | current ledger | backfill start |

Prefer serverless? [`../hint-server-cloudflare`](../hint-server-cloudflare/) is the same server as a **zero-dependency Cloudflare Worker** (Cron Trigger + KV).

Serve it over HTTPS in production (the SDK's hint fetch refuses redirects) —
a reverse proxy in front of `127.0.0.1:8787` is the intended setup. The
hosted platform API serves the same endpoints with a fuller index (all
namespaces, complete history); this example trades completeness for
independence.
