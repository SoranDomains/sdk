import {
  Account,
  Asset,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  hash,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  address,
  hex,
  namespaceNode,
  sc,
  unhex,
  utf8,
} from "./native-codec.js";
import {
  FundingError,
  fundingConfigurationFromNative,
  fundingPositionFromNative,
  fundingPositionId,
  sponsorActorFromNative,
  sponsorPolicyFromNative,
  sponsorQuoteToScVal,
  type SponsorQuote,
} from "./funding-types.js";

export type FundingOptions = {
  fundingId: string;
  registryId: string;
  lookupId: string;
  primaryId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  server?: rpc.Server;
};
export class FundingReader {
  readonly fundingId: string;
  readonly registryId: string;
  readonly lookupId: string;
  readonly primaryId: string;
  readonly passphrase: string;
  readonly server: rpc.Server;
  readonly networkId: string;
  constructor(options: FundingOptions) {
    this.fundingId = address(
      options.fundingId,
      "contract",
      "funding deployment",
    );
    this.registryId = address(options.registryId, "contract", "Registry");
    this.lookupId = address(options.lookupId, "contract", "Lookup");
    this.primaryId = address(options.primaryId, "contract", "Primary");
    this.passphrase = options.networkPassphrase ?? Networks.TESTNET;
    if (this.passphrase !== Networks.TESTNET)
      throw new FundingError("Funding V1 is currently restricted to testnet");
    this.networkId = hex(hash(utf8(this.passphrase)));
    this.server =
      options.server ??
      new rpc.Server(options.rpcUrl ?? "https://soroban-testnet.stellar.org");
  }
  async read(
    contract: string,
    method: string,
    args: xdr.ScVal[],
    minimumLedger = 1,
  ): Promise<{ value: unknown; ledger: number }> {
    const source = new Account(
      StrKey.encodeEd25519PublicKey(new Uint8Array(32)),
      "0",
    );
    const tx = new TransactionBuilder(source, {
      fee: "100",
      networkPassphrase: this.passphrase,
    })
      .addOperation(new Contract(contract).call(method, ...args))
      .setTimeout(30)
      .build();
    const result = await this.server.simulateTransaction(
      tx,
      undefined,
      undefined,
      false,
    );
    if (
      !rpc.Api.isSimulationSuccess(result) ||
      !result.result ||
      !Number.isSafeInteger(result.latestLedger) ||
      result.latestLedger < minimumLedger
    )
      throw new FundingError(
        "Cannot verify funding contract state: " +
          ("error" in result ? result.error : "missing or stale response"),
        "unavailable",
      );
    return {
      value: scValToNative(result.result.retval),
      ledger: result.latestLedger,
    };
  }
  async configuration() {
    const version = await this.read(this.fundingId, "version", []);
    if (version.value !== 1)
      throw new FundingError(
        "Unsupported Funding contract version",
        "unavailable",
      );
    const r = await this.read(
      this.fundingId,
      "configuration",
      [],
      version.ledger,
    );
    const c = fundingConfigurationFromNative(r.value);
    if (
      c.registry !== this.registryId ||
      c.lookup !== this.lookupId ||
      c.primary !== this.primaryId ||
      c.nativeAsset !== Asset.native().contractId(this.passphrase)
    )
      throw new FundingError(
        "Funding contract anchors differ from the configured deployment",
        "authorization",
      );
    return { ...c, ledger: r.ledger };
  }
  async currentPosition(namespace: string) {
    await this.configuration();
    const node = hex(namespaceNode(namespace));
    const epoch = await this.read(this.registryId, "owner_epoch", [
      sc.bytes(unhex(node)),
    ]);
    if (typeof epoch.value !== "bigint" || epoch.value < 1n)
      throw new FundingError(
        "Namespace ownership epoch unavailable",
        "unavailable",
      );
    const id = fundingPositionId(node, epoch.value);
    return { id, position: await this.position(id) };
  }
  async position(id: string) {
    const r = await this.read(this.fundingId, "fund", [sc.bytes(unhex(id))]);
    if (r.value === null || r.value === undefined) return null;
    const position = fundingPositionFromNative(r.value);
    if (fundingPositionId(position.namespace, position.ownerEpoch) !== id)
      throw new FundingError(
        "Returned funding position has a different namespace or ownership epoch",
        "unavailable",
      );
    return position;
  }
  async policy(id: string) {
    const r = await this.read(this.fundingId, "policy", [sc.bytes(unhex(id))]);
    return r.value === null || r.value === undefined
      ? null
      : sponsorPolicyFromNative(r.value);
  }
  async actorState(id: string, actor: string) {
    const r = await this.read(this.fundingId, "actor_state", [
      sc.bytes(unhex(id)),
      sc.address(address(actor, "identity", "actor")),
    ]);
    return sponsorActorFromNative(r.value);
  }
  async validateQuote(quote: SponsorQuote) {
    if (quote.funding !== this.fundingId || quote.network !== this.networkId)
      throw new FundingError(
        "Quote belongs to another deployment",
        "authorization",
      );
    await this.configuration();
    await this.read(
      this.fundingId,
      "quote_status",
      [sponsorQuoteToScVal(quote)],
      quote.issuedLedger,
    );
  }
}
