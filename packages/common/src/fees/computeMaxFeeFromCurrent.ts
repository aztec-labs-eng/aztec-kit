import type { GasLimits } from "./computeMaxFeeFromP75.ts";

/**
 * Computes a padded `maxFee` (raw FJ wei, as bigint) from calibrated gas
 * limits + the node's current minimum per-gas fees. Used as a fallback when
 * the clustec P75 feed is unavailable (on networks where the indexer isn't
 * deployed). Pair with a generous `multiplier` — current min fees have no
 * headroom built in, unlike the P75.
 *
 *   maxFee = ((daGas + teardownDaGas) * feePerDaGas
 *           + (l2Gas + teardownL2Gas) * feePerL2Gas) * multiplier
 */
export function computeMaxFeeFromCurrent(
  gasLimits: GasLimits,
  teardownGasLimits: GasLimits,
  feePerDaGas: bigint,
  feePerL2Gas: bigint,
  multiplier: number,
): bigint {
  const totalDaGas = BigInt(gasLimits.daGas + teardownGasLimits.daGas);
  const totalL2Gas = BigInt(gasLimits.l2Gas + teardownGasLimits.l2Gas);
  const baseFee = totalDaGas * feePerDaGas + totalL2Gas * feePerL2Gas;
  const multiplierBp = BigInt(Math.round(multiplier * 100));
  return (baseFee * multiplierBp) / 100n;
}
