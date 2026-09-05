/*
 * Unit coverage for SoranHolder.decodeFailure — the diagnostic-event decode path
 * that recovers a contract's typed error code from a tx that SIMULATED CLEAN but
 * FAILED AT INCLUSION. This is the densest cluster of js-xdr v5 nested-union
 * idioms in the SDK17/Protocol-28 migration and is NOT reachable from the live
 * e2e (whose typed-error cases fail at simulation, not inclusion). Build
 * synthetic v3/v4 diagnostic metas with the real v17 xdr constructors and assert
 * the code is recovered through every branch.
 *
 * Run: node --import tsx test/decode-failure.test.mts
 */
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { SoranHolder, keypairSigner, HolderError } from "../src/index.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function diagEvent(code: number, where: "topics" | "data" = "topics"): xdr.DiagnosticEvent {
  const errVal = xdr.ScVal.scvError(xdr.ScError.sceContract(code));
  const v0 = new xdr.ContractEventV0({
    topics: where === "topics" ? [xdr.ScVal.scvSymbol("error"), errVal] : [xdr.ScVal.scvSymbol("error")],
    data: where === "data" ? errVal : xdr.ScVal.scvVoid(),
  });
  const event = new xdr.ContractEvent({
    ext: xdr.ExtensionPoint.v0(),
    contractId: null,
    type: xdr.ContractEventType.contract,
    body: xdr.ContractEventBody.v0(v0),
  });
  return new xdr.DiagnosticEvent({ inSuccessfulContractCall: false, event });
}

const v3Meta = (de: xdr.DiagnosticEvent) =>
  xdr.TransactionMeta.v3(
    new xdr.TransactionMetaV3({
      ext: xdr.ExtensionPoint.v0(),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: new xdr.SorobanTransactionMeta({
        ext: xdr.SorobanTransactionMetaExt.v0(),
        events: [],
        returnValue: xdr.ScVal.scvVoid(),
        diagnosticEvents: [de],
      }),
    }),
  );

const v4Meta = (de: xdr.DiagnosticEvent) =>
  xdr.TransactionMeta.v4(
    new xdr.TransactionMetaV4({
      ext: xdr.ExtensionPoint.v0(),
      txChangesBefore: [],
      operations: [],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [de],
    }),
  );

const holder = new SoranHolder({ signer: keypairSigner(Keypair.random().secret()) });
const decode = (got: unknown): HolderError =>
  (holder as unknown as { decodeFailure: (g: unknown, c: string, f: string, e: Record<number, string>, h: string) => HolderError })
    .decodeFailure(got, "CCONTRACT", "set_record", { 7: "NotHolder", 2: "Expired" }, "def456");

{
  const e = decode({ status: "FAILED", diagnosticEventsXdr: [diagEvent(7)] });
  check("diagnosticEventsXdr topics → code 7", e instanceof HolderError && e.code === 7 && e.codeName === "NotHolder", `code=${e.code} name=${e.codeName}`);
  check("carries the tx hash", e.txHash === "def456");
}
{
  const e = decode({ status: "FAILED", resultMetaXdr: v3Meta(diagEvent(2)) });
  check("v3 sorobanMeta → code 2", e.code === 2 && e.codeName === "Expired", `code=${e.code} name=${e.codeName}`);
}
{
  const e = decode({ status: "FAILED", resultMetaXdr: v4Meta(diagEvent(7)) });
  check("v4 diagnosticEvents → code 7", e.code === 7 && e.codeName === "NotHolder", `code=${e.code} name=${e.codeName}`);
}
{
  const e = decode({ status: "FAILED", diagnosticEventsXdr: [diagEvent(2, "data")] });
  check("error in body.data → code 2", e.code === 2, `code=${e.code}`);
}
{
  const e = decode({ status: "FAILED" });
  check("no diagnostics → code null, no throw", e instanceof HolderError && e.code === null, `code=${e.code}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
