import { AztecAddress } from "@aztec-labs/aztec.js/addresses";
import { type AbiType, type ContractArtifact, type FunctionAbi } from "@aztec-labs/aztec.js/abi";
import { Contract } from "@aztec-labs/aztec.js/contracts";
import type { ContractInstanceWithAddress } from "@aztec-labs/stdlib/contract";
import { EmbeddedWallet } from "@aztec-kit/embedded-wallet";
import { SubscriptionFPC } from "@aztec-kit/contracts-aztec/subscription-fpc";
import {
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE,
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC,
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE,
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC,
  FPC_TEARDOWN_DA_GAS,
  FPC_TEARDOWN_L2_GAS,
} from "@aztec-kit/contracts-aztec/fpc-gas-constants";

/**
 * Converts user-provided string args into the format expected by contract.methods[name]().
 * Fields and integers are passed as hex strings; the contract methods API handles encoding.
 */
function parseArg(value: string, type: AbiType): unknown {
  switch (type.kind) {
    case "field":
    case "integer": {
      try {
        const v = value || "0";
        const bigint = v.startsWith("0x") ? BigInt(v) : BigInt(v);
        return "0x" + bigint.toString(16);
      } catch {
        return "0x0";
      }
    }
    case "boolean":
      return value === "true";
    case "struct": {
      if ("path" in type && typeof type.path === "string" && type.path.includes("AztecAddress"))
        return value || "0x" + "0".repeat(64);
      try {
        return "0x" + BigInt(value || "0").toString(16);
      } catch {
        return "0x0";
      }
    }
    case "array": {
      if ("type" in type && "length" in type) {
        const innerType = type.type as AbiType;
        const len = type.length as number;
        try {
          const items = JSON.parse(value) as string[];
          return items.map((item) => parseArg(String(item), innerType));
        } catch {
          return Array.from({ length: len }, () => parseArg("0", innerType));
        }
      }
      return [];
    }
    default:
      return value || "0x0";
  }
}

export interface CalibrationResult {
  /**
   * Sponsored fn's own gas limits (no FPC overhead). Committed into the
   * swap network config so runtime callers can rebuild the composite with
   * the right overhead for subscribe vs sponsor.
   */
  gasLimits: { daGas: number; l2Gas: number };
  /**
   * Subscribe-wrapped gas (gasLimits + subscribe FPC overhead). Displayed
   * to the operator as the worst-case single-tx cost; also used to size
   * the slot note's `max_fee` against the P75 fee-per-gas.
   */
  subscribeGasLimits: { daGas: number; l2Gas: number };
  teardownGasLimits: { daGas: number; l2Gas: number };
  /**
   * Whether the sponsored call enqueues a public phase. Detected at
   * calibration from the simulation result — not `sampleCall.type`,
   * because private fns can enqueue public work too.
   */
  hasPublicCall: boolean;
}

interface CalibrationBaseParams {
  adminWallet: EmbeddedWallet;
  adminAddress: AztecAddress;
  fpc: SubscriptionFPC;
  artifact: ContractArtifact;
  contractInstance: ContractInstanceWithAddress;
  selectedFunction: FunctionAbi;
  argValues: string[];
}

/**
 * Operator-facing wrapper around the shared `calibrateSponsoredApp` helper.
 * Builds the sample call from the wizard's form state, runs calibration
 * through the FPC, and augments the result with the subscribe-wrapped
 * composite + teardown limits for the UI's fee calculator.
 */
export async function runCalibration(params: CalibrationBaseParams): Promise<CalibrationResult> {
  const {
    adminWallet,
    adminAddress,
    fpc,
    artifact,
    contractInstance,
    selectedFunction,
    argValues,
  } = params;

  const adminMeta = await adminWallet.getContractMetadata(contractInstance.address);
  if (!adminMeta.instance) {
    await adminWallet.registerContract(contractInstance, artifact);
  }

  const contract = Contract.at(contractInstance.address, artifact, adminWallet);
  const parsedArgs = selectedFunction.parameters.map((p, i) =>
    parseArg(argValues[i] ?? "0", p.type),
  );
  const action = contract.methods[selectedFunction.name](...parsedArgs);
  const sampleCall = await action.getFunctionCall();

  const calibrated = await fpc.helpers.calibrate({
    adminWallet,
    adminAddress,
    sampleCall,
  });
  const gasLimits = { daGas: calibrated.daGas, l2Gas: calibrated.l2Gas };
  const hasPublicCall = calibrated.hasPublicCall;

  const subscribeOverheadDa = hasPublicCall
    ? FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC
    : FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE;
  const subscribeOverheadL2 = hasPublicCall
    ? FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC
    : FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE;

  return {
    gasLimits,
    subscribeGasLimits: {
      daGas: gasLimits.daGas + subscribeOverheadDa,
      l2Gas: gasLimits.l2Gas + subscribeOverheadL2,
    },
    teardownGasLimits: {
      daGas: FPC_TEARDOWN_DA_GAS,
      l2Gas: FPC_TEARDOWN_L2_GAS,
    },
    hasPublicCall,
  };
}
