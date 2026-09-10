import { SoranHolder, parseNativeClaimIntent, type ClaimReceipt } from "@sorandomains/holder";
import { DEPLOYMENTS } from "@sorandomains/lookup";
import { Account, BASE_FEE, Contract, StrKey, TransactionBuilder, hash, rpc, scValToNative } from "@stellar/stellar-sdk";

/** Operator configuration only. None of these fields is an MCP tool argument. */
export type HistoricalReadOptions = {
  rpcUrl?: string;
  passphrase?: string;
  registryId?: string;
  lookupId?: string | null;
};

/** The only recovery path here is read-only and requires a sealed migration. */
export async function recoverHistoricalSavedClaim(intentJson: string, options: Readonly<HistoricalReadOptions>): Promise<ClaimReceipt | null> {
  if (typeof intentJson !== "string" || intentJson.length > 16384) throw new Error("Expected the original saved claim reference (at most 16384 characters).");
  const original = parseNativeClaimIntent(intentJson);
  const preset = DEPLOYMENTS.testnet;
  const passphrase = options.passphrase ?? preset.passphrase;
  const rpcUrl = options.rpcUrl ?? preset.rpcUrl;
  const custom = passphrase !== preset.passphrase || rpcUrl !== preset.rpcUrl ||
    (options.registryId !== undefined && options.registryId !== preset.registryId);
  const lookupId = options.lookupId === undefined ? (custom ? undefined : preset.lookupId) : options.lookupId;
  if (!lookupId || !StrKey.isValidContract(lookupId)) throw new Error("Historical recovery needs an operator-configured trusted Lookup contract on this network.");
  const network = Array.from(hash(new TextEncoder().encode(passphrase)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (original.context.network !== network) throw new Error("The saved claim belongs to a different configured network.");

  // Discover the successor through the stable trust anchor. The SDK repeats
  // this lookup and verifies the complete sealed lineage at monotonic ledgers.
  const server = new rpc.Server(rpcUrl);
  const source = "GAJCWWNMBKCSTQQISDFTHFTCEOGXYA37YTP3U3ZW7Q5CYQPHSW6TB4QX";
  const tx = new TransactionBuilder(new Account(source, "0"), { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(lookupId).call("registry")).setTimeout(30).build();
  const discovery = await server.simulateTransaction(tx);
  if (!rpc.Api.isSimulationSuccess(discovery) || rpc.Api.isSimulationRestore(discovery) || !discovery.result?.retval ||
    !Number.isInteger(discovery.latestLedger) || discovery.latestLedger < 1 || discovery.latestLedger > 0xffff_ffff)
    throw new Error("The canonical Registry could not be verified.");
  const registryId: unknown = scValToNative(discovery.result.retval);
  if (typeof registryId !== "string" || !StrKey.isValidContract(registryId)) throw new Error("Trusted Lookup returned an invalid Registry.");
  const client = new SoranHolder({
    rpcUrl, passphrase, registryId, lookupId,
    signer: {
      publicKey: () => { throw new Error("Historical recovery cannot request a wallet."); },
      signTransaction: async () => { throw new Error("Historical recovery cannot sign."); },
    },
  });
  return client.recoverHistoricalClaim(original, { lookupId });
}
