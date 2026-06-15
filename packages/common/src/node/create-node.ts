import { createAztecNodeClient, type AztecNode } from "@aztec/aztec.js/node";
import { defaultFetch } from "@aztec/foundation/json-rpc/client";

/**
 * Header that API-gateway-fronted nodes require for auth.
 * Sent on every JSON-RPC request when an API key is supplied.
 */
export const AZTEC_API_KEY_HEADER = "X-Aztec-API-Key";

/**
 * Create an Aztec node RPC client, optionally authenticating with an API key.
 *
 * Networks behind an API gateway require the key; it's injected as the
 * `X-Aztec-API-Key` header on every request by wrapping the JSON-RPC client's
 * fetch. Public nodes pass no key and behave as before.
 *
 * This is the single entry point for node-client creation across the repo
 * (apps, embedded wallet, and deploy scripts) so API-key threading lives in one place.
 */
export function createNode(url: string, apiKey?: string, batchWindowMS?: number): AztecNode {
  const fetch: typeof defaultFetch | undefined = apiKey
    ? (host, body, extraHeaders = {}, noRetry = false) =>
        defaultFetch(host, body, { ...extraHeaders, [AZTEC_API_KEY_HEADER]: apiKey }, noRetry)
    : undefined;

  return createAztecNodeClient(url, undefined, fetch, batchWindowMS);
}
