import type { LocalNetworkCli } from "@aztec-kit/common/testing";

export default async function globalTeardown(): Promise<void> {
  const network = (globalThis as unknown as { __gjNetwork?: LocalNetworkCli }).__gjNetwork;
  if (network) {
    await network.stop();
    console.log("[e2e] local-network stopped");
  }
}
