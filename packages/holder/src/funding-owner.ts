import { Asset, xdr } from "@stellar/stellar-sdk";
import { FundingReader, type FundingOptions } from "./funding-reader.js";
import {
  FundingError,
  sponsorPolicyToScVal,
  type SponsorPolicy,
} from "./funding-types.js";
import { address, namespaceNode, sc, unhex } from "./native-codec.js";
import {
  sendNative,
  type NativeContext,
  type NativeSigner,
  type NativeWriteOptions,
} from "./native-transport.js";
import type { NativeInvocation } from "./native-auth.js";

/** Direct owner operations work even when the sponsorship service is offline. */
export class SoranFunding extends FundingReader {
  private context: NativeContext;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    options: FundingOptions & {
      signer: NativeSigner;
      maxNetworkFeeStroops: bigint;
    },
  ) {
    super(options);
    if (options.maxNetworkFeeStroops <= 0n)
      throw new FundingError("Choose a positive network fee limit");
    const context = {
      registryId: this.registryId,
      passphrase: this.passphrase,
      server: this.server,
      signer: options.signer,
      fee: "100",
      timeoutSecs: 60,
      maxFeeStroops: options.maxNetworkFeeStroops,
      read: async (c: string, m: string, a: xdr.ScVal[]) =>
        (await this.read(c, m, a)).value,
      readWithLedger: (c: string, m: string, a: xdr.ScVal[]) =>
        this.read(c, m, a),
      serialize: <T>(work: () => Promise<T>) => this.serialize(work),
    };
    this.context = context;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async write(
    method: string,
    args: xdr.ScVal[],
    controller: string,
    options: NativeWriteOptions,
    children: NativeInvocation[] = [],
  ) {
    const source = address(
      await this.context.signer.publicKey(),
      "account",
      "owner wallet",
    );
    if (source !== controller)
      throw new FundingError(
        "Connect the funding position's controller wallet",
        "authorization",
      );
    await this.configuration();
    return this.serialize(() =>
      sendNative(
        this.context,
        {
          source,
          contract: this.fundingId,
          method,
          args,
          sourceInvocation: {
            contract: this.fundingId,
            method,
            args,
            children,
          },
          maxFeeStroops: this.context.maxFeeStroops,
        },
        options,
      ),
    );
  }
  async open(namespace: string, options: NativeWriteOptions = {}) {
    const node = sc.bytes(namespaceNode(namespace));
    const owner = address(
      (await this.read(this.registryId, "owner_of", [node])).value,
      "identity",
      "namespace owner",
    );
    return this.write("open_fund", [node], owner, options);
  }
  private async controller(id: string) {
    const f = await this.position(id);
    if (!f) throw new FundingError("Funding position does not exist");
    return f.controller;
  }
  async deposit(id: string, amount: bigint, options: NativeWriteOptions = {}) {
    if (amount <= 0n) throw new FundingError("Deposit must be positive");
    const controller = await this.controller(id);
    return this.write(
      "deposit",
      [sc.bytes(unhex(id)), sc.i128(amount)],
      controller,
      options,
      [
        {
          contract: Asset.native().contractId(this.passphrase),
          method: "transfer",
          args: [
            sc.address(controller),
            sc.address(this.fundingId),
            sc.i128(amount),
          ],
        },
      ],
    );
  }
  async setPolicy(
    id: string,
    policy: SponsorPolicy,
    options: NativeWriteOptions = {},
  ) {
    return this.write(
      "set_policy",
      [sc.bytes(unhex(id)), sponsorPolicyToScVal(policy)],
      await this.controller(id),
      options,
    );
  }
  async setPaused(
    id: string,
    paused: boolean,
    options: NativeWriteOptions = {},
  ) {
    return this.write(
      "set_paused",
      [sc.bytes(unhex(id)), sc.bool(paused)],
      await this.controller(id),
      options,
    );
  }
  async withdraw(
    id: string,
    amount: bigint,
    recipient: string,
    options: NativeWriteOptions = {},
  ) {
    if (amount <= 0n || recipient === this.fundingId)
      throw new FundingError("Invalid withdrawal");
    return this.write(
      "withdraw",
      [
        sc.bytes(unhex(id)),
        sc.i128(amount),
        sc.address(address(recipient, "identity", "withdrawal recipient")),
      ],
      await this.controller(id),
      options,
    );
  }
  async close(id: string, options: NativeWriteOptions = {}) {
    return this.write(
      "close_fund",
      [sc.bytes(unhex(id))],
      await this.controller(id),
      options,
    );
  }
}
