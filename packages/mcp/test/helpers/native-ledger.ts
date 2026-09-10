import { Contract, xdr } from '@stellar/stellar-sdk';

/** Real SDK 17 decoded ledger entries, including their requested key. */
export function instanceProof(registrar: string, ledger = 100, hash: Uint8Array = new Uint8Array(32)) {
  const key = new Contract(registrar).getFootprint();
  const instance = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(new xdr.Hash(hash)),
    storage: null,
  });
  const val = xdr.LedgerEntryData.contractData(new xdr.ContractDataEntry({
    ext: xdr.ExtensionPoint.v0(),
    contract: new Contract(registrar).address().toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent,
    val: xdr.ScVal.scvContractInstance(instance),
  }));
  // Round-trip exactly as the RPC parser does, rather than only mocking shapes.
  return { latestLedger: ledger, entries: [{
    key: xdr.LedgerKey.fromXdr(key.toXdr()),
    val: xdr.LedgerEntryData.fromXdr(val.toXdr()),
    lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: 100_000,
  }] };
}
