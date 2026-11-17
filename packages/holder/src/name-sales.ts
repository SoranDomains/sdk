import { Asset, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { type NativeInvocation } from "./native-auth.js";
import { NativeClaimError, address, amount, bool, bytes32, exactObject, hex, hex32, namespaceNode, paymentDestinationToScVal, sameScVal, sc, struct, u32, u64, unhex, utf8 } from "./native-codec.js";
import { nativeWalletPlan, sendNative, verifyRegistrarProvenance, type NativeContext, type NativeWriteOptions } from "./native-transport.js";
import { parseResolvableName, resolvableNameNode } from "./names.js";
import type { PaymentDestination } from "./payment.js";

export type NameSaleQuoteRequest = { priceStroops: bigint; payout: string; deadline: bigint };
export type NameSaleListing = {
  networkPassphrase: string; registry: string; registrar: string; name: string; node: string;
  seller: string; generation: bigint; revision: bigint; priceStroops: bigint; payout: string; deadline: bigint;
  soranBps: number; soranRecipient: string; soranFeeStroops: bigint;
  namespaceBps: number; namespaceRecipient: string; namespaceFeeStroops: bigint; sellerNetStroops: bigint;
};
export type NameSaleState =
  | { supported: false }
  | { supported: true; eligible: boolean; holder: string | null; listing: NameSaleListing | null };

type BoundSale = Pick<NameSaleListing, "networkPassphrase" | "registry" | "registrar" | "name">;
const termFields = ["label", "node", "seller", "generation", "revision", "price", "payout", "deadline", "soran_bps", "soran_recipient", "soran_fee", "namespace_bps", "namespace_recipient", "namespace_fee", "seller_net"];
const maxNativeAmount = (1n << 63n) - 1n;

function directName(input: string) {
  const parsed = parseResolvableName(input);
  if (parsed.childLabel !== null) throw new NativeClaimError("Only direct names can be listed for sale");
  return parsed;
}

function price(value: unknown) {
  const result = amount(value, "sale price");
  if (result === 0n || result > maxNativeAmount) throw new NativeClaimError("XLM sale price is outside the supported range");
  return result;
}

function verifiedTerms(raw: unknown, bound: BoundSale): NameSaleListing {
  const t = exactObject(raw, termFields, "name listing");
  const { label } = directName(bound.name);
  if (!(t.label instanceof Uint8Array) || hex(t.label) !== hex(utf8(label)) || hex(bytes32(t.node, "listed node")) !== hex(resolvableNameNode(bound.name)))
    throw new NativeClaimError("Listing refers to another name", "unavailable");
  const priceStroops = price(t.price);
  const soranBps = u32(t.soran_bps, "Soran fee basis points");
  const namespaceBps = u32(t.namespace_bps, "namespace fee basis points");
  const soranFeeStroops = amount(t.soran_fee, "Soran fee");
  const namespaceFeeStroops = amount(t.namespace_fee, "namespace fee");
  const sellerNetStroops = amount(t.seller_net, "seller proceeds");
  if (soranBps + namespaceBps >= 10_000 || soranFeeStroops !== priceStroops * BigInt(soranBps) / 10_000n ||
      namespaceFeeStroops !== priceStroops * BigInt(namespaceBps) / 10_000n ||
      sellerNetStroops !== priceStroops - soranFeeStroops - namespaceFeeStroops)
    throw new NativeClaimError("Listing fees and seller proceeds do not match the price", "unavailable");
  return {
    name: bound.name, registry: bound.registry, registrar: bound.registrar, networkPassphrase: bound.networkPassphrase,
    node: hex(t.node as Uint8Array), seller: address(t.seller, "identity", "seller"),
    generation: u64(t.generation, "name generation"), revision: u64(t.revision, "listing revision"),
    priceStroops, payout: address(t.payout, "identity", "seller payout"), deadline: u64(t.deadline, "listing deadline"),
    soranBps, soranRecipient: address(t.soran_recipient, "identity", "Soran fee recipient"), soranFeeStroops,
    namespaceBps, namespaceRecipient: address(t.namespace_recipient, "identity", "namespace fee recipient"),
    namespaceFeeStroops, sellerNetStroops,
  };
}

function encodeTerms(t: NameSaleListing) {
  return struct({
    label: sc.bytes(utf8(directName(t.name).label)), node: sc.bytes(unhex(hex32(t.node, "listed node"))),
    seller: sc.address(t.seller), generation: sc.u64(u64(t.generation, "name generation")),
    revision: sc.u64(u64(t.revision, "listing revision")), price: sc.i128(price(t.priceStroops)),
    payout: sc.address(t.payout), deadline: sc.u64(u64(t.deadline, "listing deadline")),
    soran_bps: sc.u32(u32(t.soranBps, "Soran fee basis points")), soran_recipient: sc.address(t.soranRecipient), soran_fee: sc.i128(amount(t.soranFeeStroops, "Soran fee")),
    namespace_bps: sc.u32(u32(t.namespaceBps, "namespace fee basis points")), namespace_recipient: sc.address(t.namespaceRecipient), namespace_fee: sc.i128(amount(t.namespaceFeeStroops, "namespace fee")),
    seller_net: sc.i128(amount(t.sellerNetStroops, "seller proceeds")),
  });
}

export class NameSales {
  constructor(private readonly context: NativeContext) {}

  private async binding(input: string) {
    const { name, namespace, label } = directName(input);
    const registry = this.context.registryId;
    const node = namespaceNode(namespace);
    const registrarRead = await this.context.read(registry, "registrar_of", [sc.bytes(node)]);
    if (registrarRead === null) return null;
    const registrar = address(registrarRead, "contract", "namespace Registrar");
    // This version method is a constant. Only a missing function on the selected
    // contract indicates an older implementation. Timeouts and storage errors propagate.
    let version: unknown;
    try { version = await this.context.read(registrar, "name_sale_version", []); }
    catch (error) {
      if (error instanceof Error && /Error\(WasmVm, MissingValue\)/.test(error.message)) return null;
      throw error;
    }
    if (u32(version, "name sale version") !== 2) return null;
    const [, anchors] = await Promise.all([
      verifyRegistrarProvenance(this.context, registrar, hex(node)),
      this.context.read(registrar, "anchors", []),
    ]);
    if (!Array.isArray(anchors) || anchors.length !== 2 || anchors[0] !== registry || hex(bytes32(anchors[1], "namespace anchor")) !== hex(node))
      throw new NativeClaimError("Sale Registrar is not bound to this Registry and namespace", "unavailable");
    return { name, label, namespace, networkPassphrase: this.context.passphrase, registry, registrar };
  }

  private async saleResolver(bound: BoundSale & { namespace: string }) {
    const pair = await this.context.read(bound.registry, "native_contracts", [sc.bytes(namespaceNode(bound.namespace))]);
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== bound.registrar)
      throw new NativeClaimError("Sale Registrar is not bound to this Registry and namespace", "unavailable");
    return address(pair[1], "contract", "sale Resolver");
  }

  private async storedListing(bound: BoundSale & { label: string }, holder: string): Promise<NameSaleListing | null> {
    const label = sc.bytes(utf8(bound.label));
    const [raw, rawRecord] = await Promise.all([
      this.context.read(bound.registrar, "name_listing_for_holder", [label]),
      this.context.read(bound.registrar, "record_of", [label]),
    ]);
    if (raw === null) return null;
    const listing = verifiedTerms(raw, bound);
    const record = exactObject(rawRecord, ["holder", "address", "generation", "expires_at"], "name record");
    if (listing.seller !== record.holder || listing.generation !== u64(record.generation, "name generation"))
      throw new NativeClaimError("Stored listing and ownership disagree; refresh before canceling", "unavailable");
    return listing.seller === holder ? listing : null;
  }

  async forHolder(name: string, holder: string): Promise<NameSaleListing | null> {
    const account = address(holder, "identity", "listing holder");
    const bound = await this.binding(name);
    return bound ? this.storedListing(bound, account) : null;
  }

  async state(name: string): Promise<NameSaleState> {
    const bound = await this.binding(name);
    if (!bound) return { supported: false };
    const labelArg = sc.bytes(utf8(bound.label));
    const [, rawListing, policyRaw, live, rawRecord] = await Promise.all([
      this.saleResolver(bound),
      this.context.read(bound.registrar, "name_listing", [labelArg]),
      this.context.read(bound.registrar, "policy", []),
      this.context.read(bound.registrar, "holder_and_generation", [sc.bytes(resolvableNameNode(bound.name))]),
      this.context.read(bound.registrar, "record_of", [labelArg]),
    ]);
    const policy = exactObject(policyRaw, ["reclaimable", "transferable", "tradeable", "default_term_secs", "trade_fee_bps"], "namespace policy");
    const reclaimable = bool(policy.reclaimable, "reclaim policy"), tradeable = bool(policy.tradeable, "sale policy"), transferable = bool(policy.transferable, "transfer policy");
    const term = u64(policy.default_term_secs, "name term");
    const record = rawRecord === null ? null : exactObject(rawRecord, ["holder", "address", "generation", "expires_at"], "name record");
    if (live !== null && (!Array.isArray(live) || live.length !== 2 || !record || record.holder !== live[0] || u64(record.generation, "name generation") !== u64(live[1], "live name generation")))
      throw new NativeClaimError("Inconsistent live name ownership; refresh before trading", "unavailable");
    const holder = live === null ? null : address(live[0], "identity", "current name holder");
    const eligible = !!holder && !!record && u64(record.expires_at, "name expiry") === 0n && term === 0n && !reclaimable && tradeable && transferable;
    const listing = rawListing === null ? null : verifiedTerms(rawListing, bound);
    if (listing && (!eligible || holder !== listing.seller || listing.generation !== record?.generation))
      throw new NativeClaimError("Listing and live ownership disagree; refresh before trading", "unavailable");
    return { supported: true, eligible, holder, listing };
  }

  async quote(name: string, request: NameSaleQuoteRequest): Promise<NameSaleListing> {
    const { priceStroops, payout, deadline } = request;
    const bound = await this.binding(name);
    if (!bound) throw new NativeClaimError("Namespace does not support individual name sales", "unsupported");
    const [, raw] = await Promise.all([
      this.saleResolver(bound),
      this.context.read(bound.registrar, "quote_name_sale", [
        sc.bytes(utf8(bound.label)), sc.i128(price(priceStroops)), sc.address(address(payout, "identity", "seller payout")), sc.u64(u64(deadline, "listing deadline")),
      ]),
    ]);
    const listing = verifiedTerms(raw, bound);
    if (listing.priceStroops !== priceStroops || listing.payout !== payout || listing.deadline !== deadline)
      throw new NativeClaimError("Sale quote differs from the requested price, payout or deadline", "unavailable");
    return listing;
  }

  async write(method: "list_name" | "cancel_name_listing" | "buy_name", input: NameSaleListing, destination: PaymentDestination | null, options: NativeWriteOptions) {
    const encoded = encodeTerms(input);
    // Snapshot the reviewed terms before any asynchronous RPC or wallet work.
    const scope = { name: input.name, registry: input.registry, registrar: input.registrar, networkPassphrase: input.networkPassphrase };
    const listing = verifiedTerms(scValToNative(encoded), scope);
    const receiving = destination === null ? null : paymentDestinationToScVal(destination);
    return this.context.serialize(async () => {
      const bound = await this.binding(listing.name);
      if (!bound || bound.registrar !== scope.registrar || bound.registry !== scope.registry || bound.networkPassphrase !== scope.networkPassphrase)
        throw new NativeClaimError("Reviewed listing belongs to a different deployment", "authorization");
      const wallet = await nativeWalletPlan(this.context);
      const actor = wallet.actor?.account ?? wallet.source;
      const buying = method === "buy_name";
      if (buying ? actor === listing.seller : actor !== listing.seller)
        throw new NativeClaimError(buying ? "Seller cannot buy their own listing" : "Only the listing seller may authorize this action", "authorization");
      const label = sc.bytes(utf8(bound.label));
      let current: NameSaleListing | null;
      let resolver: string | undefined;
      if (method === "cancel_name_listing") {
        current = await this.storedListing(bound, actor);
      } else {
        resolver = await this.saleResolver(bound);
        const raw = method === "list_name"
          ? await this.context.read(bound.registrar, "quote_name_sale", [label, sc.i128(listing.priceStroops), sc.address(listing.payout), sc.u64(listing.deadline)])
          : await this.context.read(bound.registrar, "name_listing", [label]);
        current = raw === null ? null : verifiedTerms(raw, bound);
      }
      if (current === null || !sameScVal(encodeTerms(current), encoded))
        throw new NativeClaimError("Listing terms changed; refresh before signing", "unavailable");

      let args: xdr.ScVal[];
      const children: NativeInvocation[] = [];
      if (buying) {
        args = [encoded, sc.address(actor), sc.option(receiving)];
        const token = Asset.native().contractId(this.context.passphrase);
        const payouts: [string, bigint][] = [
          [listing.payout, listing.sellerNetStroops], [listing.soranRecipient, listing.soranFeeStroops],
          [listing.namespaceRecipient, listing.namespaceFeeStroops],
        ];
        for (const [recipient, stroops] of payouts) {
          if (stroops > 0n) children.push({ contract: token, method: "transfer", args: [sc.address(actor), sc.address(recipient), sc.i128(stroops)] });
        }
        if (receiving && resolver) children.push({ contract: resolver, method: "initialize_destination", args: [
          label, sc.address(actor), sc.u64(u64(listing.generation + 1n, "new name generation")), receiving,
        ] });
      } else {
        args = method === "list_name" ? [encoded] : [label, sc.u64(listing.revision)];
      }
      const result = await sendNative(this.context, {
        ...wallet, contract: bound.registrar, method, args, maxFeeStroops: this.context.maxFeeStroops,
        sourceInvocation: { contract: bound.registrar, method, args, children },
      }, options);
      return { hash: result.hash, ledger: result.ledger };
    });
  }
}
