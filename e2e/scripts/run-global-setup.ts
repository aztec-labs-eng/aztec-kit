#!/usr/bin/env node
/**
 * Runs just the Playwright globalSetup in isolation, without spawning any
 * dev servers or browsers. Useful for debugging the setup pipeline without
 * paying the full e2e cost.
 *
 * Usage:
 *   # from repo root, with `aztec start --local-network` already running:
 *   node e2e/scripts/run-global-setup.ts
 */
import globalSetup from "../fixtures/global-setup.ts";

process.env.E2E_SKIP_NETWORK ??= "1";

await globalSetup({} as never);
console.log("\n[run-global-setup] done");
