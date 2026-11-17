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
  upkeepPositionId,
  upkeepPositionFromNative,
  upkeepPolicyFromNative,
  storagePlanToScVal,
  upkeepQuoteToScVal,
  type StoragePlan,
  type UpkeepQuote,
  executionApprovalFromNative, executionWithdrawalFromNative, executionQuoteToScVal,
  type ExecutionQuote,
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
    if (options.server) {
      // A supplied client retains its caller-reviewed transport configuration.
      this.server = options.server;
    } else {
      this.server = new rpc.Server(options.rpcUrl ?? "https://soroban-testnet.stellar.org");
      // SDK 17 ignores the constructor's timeout option. Bound the HTTP client
      // actually used by simulation and ledger requests, as the API RPC factory does.
      this.server.httpClient.defaults.timeout = 15_000;
    }
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
    // A simulation that needs a restore preamble still reports success, with the
    // value computed as if the archived entry were live; it is not a live read.
    if (rpc.Api.isSimulationRestore(result))
      throw new FundingError(
        "Cannot verify funding contract state: an archived entry needs restoring",
        "unavailable",
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
    const data = result.transactionData.build();
    if (
      data.ext.type !== "v0" &&
      (data.ext.type !== "resourceExt" ||
        data.ext.value.archivedSorobanEntries.length > 0)
    )
      throw new FundingError(
        "Cannot verify live funding state: archived entries require explicit restoration",
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
  async upkeepConfiguration() {
    const config = await this.configuration();
    if (
      (await this.read(this.fundingId, "upkeep_version", [], config.ledger))
        .value !== 1
    )
      throw new FundingError(
        "Owner-funded storage is not installed on this deployment",
        "unavailable",
      );
    return config;
  }
  async isUpkeepEnrolled(namespace:string):Promise<boolean> {
    await this.upkeepConfiguration();
    const r=await this.read(this.fundingId,"upkeep_enrolled",[sc.bytes(namespaceNode(namespace))]);
    if(typeof r.value!=="boolean")throw new FundingError("Namespace storage billing boundary is unavailable","unavailable");
    return r.value;
  }
  async currentUpkeep(namespace: string) {
    await this.upkeepConfiguration();
    const node = hex(namespaceNode(namespace));
    const epoch = await this.read(this.registryId, "owner_epoch", [
      sc.bytes(unhex(node)),
    ]);
    if (typeof epoch.value !== "bigint" || epoch.value < 1n)
      throw new FundingError(
        "Namespace ownership epoch unavailable",
        "unavailable",
      );
    const id = upkeepPositionId(node, epoch.value);
    return { id, position: await this.upkeepPosition(id) };
  }
  async upkeepPosition(id: string) {
    const r = await this.read(this.fundingId, "upkeep_position", [
      sc.bytes(unhex(id)),
    ]);
    if (r.value === null || r.value === undefined) return null;
    const p = upkeepPositionFromNative(r.value);
    if (upkeepPositionId(p.namespace, p.ownerEpoch) !== id)
      throw new FundingError(
        "Upkeep ownership epoch does not match",
        "unavailable",
      );
    return p;
  }
  async upkeepPolicy(id: string) {
    const r = await this.read(this.fundingId, "upkeep_policy", [
      sc.bytes(unhex(id)),
    ]);
    return r.value === null || r.value === undefined
      ? null
      : upkeepPolicyFromNative(r.value);
  }
  async storagePlan(namespace: string): Promise<StoragePlan> {
    await this.upkeepConfiguration();
    const pair = (
      await this.read(this.registryId, "native_contracts", [
        sc.bytes(namespaceNode(namespace)),
      ])
    ).value;
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new FundingError(
        "Native namespace pair unavailable",
        "unavailable",
      );
    const plan = {
      registrar: address(pair[0], "contract", "Registrar"),
      resolver: address(pair[1], "contract", "Resolver"),
      registrarKeys: [],
      resolverKeys: [],
    };
    for (const c of [plan.registrar, plan.resolver])
      if ((await this.read(c, "storage_upkeep_version", [])).value !== 1)
        throw new FundingError(
          "Namespace storage upgrade required",
          "unavailable",
        );
    return plan;
  }
  async upkeepCoverage(id: string, plan: StoragePlan): Promise<number[]> {
    const r = await this.read(this.fundingId, "upkeep_coverage", [
      sc.bytes(unhex(id)),
      storagePlanToScVal(plan),
    ]);
    if (
      !Array.isArray(r.value) ||
      r.value.some((v) => !Number.isSafeInteger(v) || v < 0)
    )
      throw new FundingError(
        "Invalid storage coverage response",
        "unavailable",
      );
    return r.value as number[];
  }
  async validateUpkeepQuote(q: UpkeepQuote) {
    if (q.funding !== this.fundingId || q.network !== this.networkId)
      throw new FundingError(
        "Upkeep quote belongs to another deployment",
        "authorization",
      );
    await this.upkeepConfiguration();
    await this.read(
      this.fundingId,
      "upkeep_quote_status",
      [upkeepQuoteToScVal(q)],
      q.issuedLedger,
    );
  }
  async executionConfiguration() {
    await this.upkeepConfiguration();
    if((await this.read(this.fundingId,"execution_version",[])).value!==2)
      throw new FundingError("Prepaid execution contract upgrade required","unavailable");
    return {version:2 as const,wallet:address((await this.read(this.fundingId,"execution_wallet",[])).value,"account","custodial execution wallet")};
  }
  async executionApproval(id:string) {
    const value=(await this.read(this.fundingId,"execution_approval",[sc.bytes(unhex(id))])).value;
    return value==null?null:executionApprovalFromNative(value);
  }
  async executionWithdrawal(id:string,nonce:bigint) {
    const value=(await this.read(this.fundingId,"execution_withdrawal",[sc.bytes(unhex(id)),sc.u64(nonce)])).value;
    return value==null?null:executionWithdrawalFromNative(value);
  }
  async executionWithdrawalNonce(id:string) {
    const value=(await this.read(this.fundingId,"execution_withdrawal_nonce",[sc.bytes(unhex(id))])).value;
    if(typeof value!=="bigint"||value<0n)throw new FundingError("Invalid withdrawal cursor","unavailable");
    return value;
  }
  async validateExecutionQuote(q:ExecutionQuote) {
    if(q.funding!==this.fundingId||q.network!==this.networkId)throw new FundingError("Execution quote belongs to another deployment","authorization");
    await this.read(this.fundingId,"execution_quote_status",[executionQuoteToScVal(q)],q.issuedLedger);
  }
}
