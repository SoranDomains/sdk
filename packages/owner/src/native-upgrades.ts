import { xdr } from "@stellar/stellar-sdk";
import { NativeClaimError, address, bool, bytes32, exactObject, hex, namespaceNode, sc, u32 } from "./native-codec.js";
import { expectedNativeCode } from "./native-code-policy.js";
import type { NativeContext, NativeWriteOptions } from "./native-transport.js";

export type ContractUpgradeRole = "registrar" | "resolver";
export type ContractUpgradeOptions = NativeWriteOptions & {
  /** Explicit acknowledgement that installing a superseded (older) release, or the latest known release over code this SDK cannot place, is intended. A reinstall of the installed hash is never allowed. */
  allowDowngrade?: boolean;
};
export type ContractUpgradeStatus = {
  owner: string;
  contractId: string;
  currentHash: string;
  approved: boolean;
  governed: boolean;
};

/**
 * Reviewed implementation lineage of the governed testnet Registry. Governance
 * approval means "this hash may be installed on any namespace", not "this is a
 * safe transition": superseded releases stay approved, so the chain accepts a
 * downgrade. `latest` is the release owners are offered; `superseded` are the
 * older releases it replaces. A test keeps this equal to the web catalog
 * (web/lib/contractUpdates.ts) and the release record; adding a release means
 * moving the old `latest` into `superseded` here and there.
 */
export const CONTRACT_RELEASES = {
  registrar: {
    latest: "4d6d18625f4d890028acb794b24871c5c93f96dc15d94cf3d52cbf9713b07fb1",
    superseded: [
      "42dc5f8b40932617d3f2667e1d26dad3e5e9a62c63de1fde7c016cb67a86c420",
      "5c8ae72ea7370ccf19af52b9bbc0007362be94464651ccdf68a2bb1f478b6f2c",
      "61ded153e6311075c1087c5639a5410222e23f7cade239ed2c946150af94b1c5",
      "26e03cd1d7fbfa46fe442406fb1b88022ec8cd8bd9123bed570f971fce596a14",
    ],
  },
  resolver: {
    latest: "941bf87f26cb817f3c6a52a326de855cca8a1dc4477e62a38ec4ffa5c7f43806",
    superseded: [
      "cb927ffa19d6b1f3f0b0187048d885e200adb6de3fddd11ee3cfeb59df9c5c48",
      "351bf4e056b179b578fe2a4ea46f937bfafccc6538c7357ea70021b7038d91ea",
      "c6dfcd7bbf35943a13406888678334d0938d0fea54939906b00c2dc37b4a9a71",
      "5e7b4fb8d310d67ed6966a155e748d60be771422b3e8c34bbc14485f98525574",
    ],
  },
} as const;

/**
 * How installing `targetHash` over `currentHash` relates to the reviewed lineage:
 * - "same": already installed (never installable again);
 * - "backward": the target is a superseded release, so this is a downgrade;
 * - "forward": the latest known release over a known superseded one;
 * - "unrecognized-current": the latest known release over code this SDK cannot
 *   place, which may be a newer release, so installing it could be a downgrade;
 * - "unreviewed-target": a release this SDK has no lineage for (newer than the SDK
 *   or custom); direction cannot be judged and the caller's review is trusted.
 */
export type ContractUpgradeDirection = "forward" | "same" | "backward" | "unrecognized-current" | "unreviewed-target";
export function contractUpgradeDirection(role: ContractUpgradeRole, currentHash: string, targetHash: string): ContractUpgradeDirection {
  const { latest, superseded } = CONTRACT_RELEASES[role] as { latest: string; superseded: readonly string[] };
  if (currentHash === targetHash) return "same";
  if (superseded.includes(targetHash)) return "backward";
  if (targetHash !== latest) return "unreviewed-target";
  return superseded.includes(currentHash) ? "forward" : "unrecognized-current";
}

export function upgradeHash(hash: string): xdr.ScVal {
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
    throw new NativeClaimError("Contract implementation hash must be lowercase hex32");
  return sc.bytes(Uint8Array.from(hash.match(/../g)!, value => parseInt(value, 16)));
}

/** Independent of claim versions, claim configuration and fee-token policy. */
export async function contractUpgradeStatus(
  context: NativeContext,
  namespace: string,
  role: ContractUpgradeRole,
  wasmHash: string,
): Promise<ContractUpgradeStatus> {
  if (role !== "registrar" && role !== "resolver") throw new NativeClaimError("Unknown namespace contract role");
  const target = upgradeHash(wasmHash);
  const node = namespaceNode(namespace), args = [sc.bytes(node)];
  const [pair, owner, code, registrar, resolver, selected, registrarTainted, resolverTainted] = await Promise.all([
    context.read(context.registryId, "native_contracts", args),
    context.read(context.registryId, "owner_of", args),
    expectedNativeCode(context, hex(node)),
    context.read(context.registryId, "registrar_of", args),
    context.read(context.registryId, "attested_resolver_of", args),
    context.read(context.registryId, "resolver_of", args),
    context.read(context.registryId, "registrar_tainted", args),
    context.read(context.registryId, "resolver_tainted", args),
  ]);
  const fail = (message: string): never => { throw new NativeClaimError(message, "unavailable"); };
  if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== registrar || pair[1] !== resolver || selected !== resolver || registrarTainted !== false || resolverTainted !== false)
    fail("Namespace contracts are missing, tainted or differ from the Registry's native binding");
  const registrarId = address(registrar, "contract", "namespace Registrar");
  const resolverId = address(resolver, "contract", "namespace Resolver");
  const contractId = role === "registrar" ? registrarId : resolverId;
  const [registrarInstance, resolverInstance, anchors, provenanceRaw, authority, registry, version] = await Promise.all([
    context.server.getContractInstance(registrarId),
    context.server.getContractInstance(resolverId),
    context.read(registrarId, "anchors", []),
    context.read(resolverId, "provenance", []),
    context.read(resolverId, "authority", []),
    context.read(resolverId, "registry", []),
    // A verified legacy Registry is safely reported as disallowed without probing a new child ABI.
    code.governed ? context.read(contractId, "upgrade_policy_version", []) : 0,
  ]);
  for (const [instance, expected] of [[registrarInstance, code.registrar], [resolverInstance, code.resolver]] as const) {
    if (instance.executable.type !== "contractExecutableWasm" || hex(instance.executable.wasmHash.value) !== expected)
      fail("Namespace contract executable differs from Registry-approved code");
  }
  if (!Array.isArray(anchors) || anchors.length !== 2 || anchors[0] !== context.registryId || hex(bytes32(anchors[1], "Registrar namespace")) !== hex(node))
    fail("Registrar anchors differ from selected namespace");
  const provenance = exactObject(provenanceRaw, ["registry", "node"], "Resolver provenance");
  if (provenance.registry !== context.registryId || hex(bytes32(provenance.node, "Resolver namespace")) !== hex(node) || authority !== registrarId || registry !== context.registryId)
    fail("Resolver provenance or authority differs from selected namespace");
  const governed = code.governed && u32(version, "contract upgrade policy") === 1;
  const approved = code.governed
    ? bool(await context.read(context.registryId, "implementation_approved", [sc.u32(role === "registrar" ? 0 : 1), target]), "implementation approval")
    : false;
  return { owner: address(owner, "identity", "namespace owner"), contractId, currentHash: code[role], approved, governed };
}
