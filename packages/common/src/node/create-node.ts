import { createAztecNodeClient, type AztecNode } from "@aztec-labs/aztec.js/node";
import { defaultFetch } from "@aztec-labs/foundation/json-rpc/client";

/**
 * Auth header the node gateway requires. staging-public (and the v6 networks behind it) is
 * fronted by Kong, which reads the key from `x-aztec-api-key` — any other header name comes back
 * `401 {"message":"No API key found in request"}`, and its CORS preflight allows only this one.
 */
export const AZTEC_API_KEY_HEADER = "x-aztec-api-key";

/**
 * Create an Aztec node RPC client, optionally authenticating with an API key.
 *
 * Networks behind an API gateway require the key; it's injected as the
 * the gateway's API-key header on every request by wrapping the JSON-RPC client's
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

  return createAztecNodeClient(url, { fetch, batchWindowMS });
}
