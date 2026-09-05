/*
 * Unit coverage for SoranOwner.decodeFailure — the diagnostic-event decode path
 * that recovers a contract's typed error code from a tx that SIMULATED CLEAN but
 * FAILED AT INCLUSION (a simulate/apply race). This path is the densest cluster
 * of js-xdr v5 nested-union idioms in the SDK17/Protocol-28 migration
 * (d.event.body.value → v.type==="scvError" → err.type==="sceContract" →
 * err.contractCode, across v3 sorobanMeta and v4 top-level diagnosticEvents) and
 * is NOT reachable from the live e2e (whose typed-error cases fail at simulation,
 * not inclusion). Build synthetic diagnostic metas with the real v17 xdr
 * constructors and assert the code is recovered through every branch.
 *
 * Run: node --import tsx test/decode-failure.test.mts
 */
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { SoranOwner, keypairSigner, OwnerError } from "../src/index.js";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// A DiagnosticEvent carrying an Error(Contract, #code) — placed in topics or data.
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

// decodeFailure is private; call it white-box. No network is touched.
const owner = new SoranOwner({ signer: keypairSigner(Keypair.random().secret()) });
const decode = (got: unknown): OwnerError =>
  (owner as unknown as { decodeFailure: (g: unknown, c: string, f: string, e: Record<number, string>, h: string) => OwnerError })
    .decodeFailure(got, "CCONTRACT", "issue", { 13: "NotEligible", 5: "Taken" }, "abc123");

// 1. diagnosticEventsXdr array (the pre-supplied path) — error in topics
{
  const e = decode({ status: "FAILED", diagnosticEventsXdr: [diagEvent(13)] });
  check("diagnosticEventsXdr topics → code 13", e instanceof OwnerError && e.code === 13 && e.codeName === "NotEligible", `code=${e.code} name=${e.codeName}`);
  check("carries the tx hash", e.txHash === "abc123");
}

// 2. v3 sorobanMeta.diagnosticEvents branch
{
  const e = decode({ status: "FAILED", resultMetaXdr: v3Meta(diagEvent(5)) });
  check("v3 sorobanMeta → code 5", e.code === 5 && e.codeName === "Taken", `code=${e.code} name=${e.codeName}`);
}

// 3. v4 top-level diagnosticEvents branch
{
  const e = decode({ status: "FAILED", resultMetaXdr: v4Meta(diagEvent(13)) });
  check("v4 diagnosticEvents → code 13", e.code === 13 && e.codeName === "NotEligible", `code=${e.code} name=${e.codeName}`);
}

// 4. error carried in body.data rather than topics
{
  const e = decode({ status: "FAILED", diagnosticEventsXdr: [diagEvent(5, "data")] });
  check("error in body.data → code 5", e.code === 5, `code=${e.code}`);
}

// 5. no diagnostics anywhere → falls through to null code (still a well-formed OwnerError)
{
  const e = decode({ status: "FAILED" });
  check("no diagnostics → code null, no throw", e instanceof OwnerError && e.code === null, `code=${e.code}`);
}

// 6. unknown code (not in errNames) → code set, codeName null
{
  const e = decode({ status: "FAILED", diagnosticEventsXdr: [diagEvent(99)] });
  check("unknown code 99 → code set, name null", e.code === 99 && e.codeName === null, `code=${e.code} name=${e.codeName}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
