import { hash } from "@stellar/stellar-sdk";

/**
 * Operation-bound confirmation for state-changing MCP tools.
 *
 * A tool call is refused until it carries a `confirm` code that the SERVER
 * computed for that exact operation (tool, arguments, signing wallet and
 * network). The refusal returns the code together with a plain rendering of
 * the operation, so the confirmation the model sends back is bound to what the
 * human was shown: a literal such as "CONFIRM" cannot be pre-filled from a tool
 * description or an injected instruction, a code issued for one operation is
 * useless for another (change the destination, amount or namespace and the
 * code no longer matches), and a code expires.
 *
 * This is NOT out-of-band approval. An agent that can call the tool twice can
 * still copy the code from the refusal to the retry, so the real check is the
 * human reading the refusal (or the MCP client's per-call approval prompt,
 * which now shows the operation-specific code). It removes one-shot and
 * pre-authorised abuse and makes the gate uniform; it does not replace a
 * client-side human prompt.
 */
export type ConfirmationOptions = {
  /** The signing wallet: part of the bound operation. */
  wallet: string;
  /** The pinned network passphrase: part of the bound operation. */
  network: string;
  /** Clock (ms), injectable for tests. */
  now?: () => number;
  /** Per-process secret mixed into every code, injectable for tests. */
  key?: Uint8Array;
};

/** A code is valid from its issue until the end of the following window: 5 to 10 minutes. */
const WINDOW_MS = 300_000;

export type ConfirmationResult = { isError: true; content: Array<{ type: "text"; text: string }> };

/** Deterministic JSON: keys sorted, bigint as decimal string, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return v;
  });
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

export function createConfirmationGate(options: ConfirmationOptions) {
  const now = options.now ?? Date.now;
  const key = options.key ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
  const code = (prefix: string, tool: string, operation: unknown, window: number) => {
    const material = new TextEncoder().encode(canonicalJson({ tool, wallet: options.wallet, network: options.network, operation, window }));
    const input = new Uint8Array(key.length + 1 + material.length);
    input.set(key, 0); input[key.length] = 0; input.set(material, key.length + 1);
    return `${prefix}-${hex(new Uint8Array(hash(input as Buffer))).slice(0, 20)}`;
  };
  return {
    /** null when `given` confirms exactly this operation; otherwise the refusal to return to the model. */
    check(tool: string, operation: Record<string, unknown>, given: string | undefined, irreversible = false): ConfirmationResult | null {
      const prefix = irreversible ? "IRREVERSIBLE" : "CONFIRM";
      const window = Math.floor(now() / WINDOW_MS);
      if (typeof given === "string" && (given === code(prefix, tool, operation, window) || given === code(prefix, tool, operation, window - 1))) return null;
      const confirm = code(prefix, tool, operation, window);
      const message = `refusing: ${tool} is a high-impact write and was NOT executed. Show the human the operation below and ask for approval` +
        `${irreversible ? " (it is IRREVERSIBLE)" : ""}. Only if they approve, call ${tool} again with exactly these arguments plus confirm set to the code below. ` +
        "The code is computed for this exact operation and expires in about ten minutes; never guess, reuse or pre-fill one.";
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "ConfirmationRequired", message, confirm, tool, wallet: options.wallet, network: options.network, operation }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }] };
    },
  };
}
export type ConfirmationGate = ReturnType<typeof createConfirmationGate>;
