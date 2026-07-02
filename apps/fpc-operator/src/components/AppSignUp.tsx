import { useState, useMemo } from "react";
import {
  Box,
  Button,
  TextField,
  Typography,
  CircularProgress,
  Alert,
  Stepper,
  Step,
  StepLabel,
  StepContent,
  ToggleButtonGroup,
  ToggleButton,
  Chip,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  FormControlLabel,
  Switch,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { shortAddress } from "@aztec-kit/common/ui";
import { getContractInstanceFromInstantiationParams } from "@aztec/stdlib/contract";
import { Fr } from "@aztec/aztec.js/fields";
import { parseUnits } from "viem";
import {
  FunctionSelector as AztecFunctionSelector,
  type ContractArtifact,
  type FunctionAbi,
  getAllFunctionAbis,
} from "@aztec/aztec.js/abi";
import { getDefaultInitializer, getInitializer } from "@aztec/stdlib/abi";
import type { ContractInstanceWithAddress } from "@aztec/stdlib/contract";
import type { SubscriptionFPCContract } from "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC";
import { SubscriptionFPC } from "@aztec-kit/contracts-aztec/subscription-fpc";
import { useWallet } from "../contexts/WalletContext";
import { useAliases } from "../contexts/AliasContext";
import { signUpApp } from "../services/fpcService";
import { runCalibration, type CalibrationResult as CalibrationData } from "../services/calibration";
import {
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC,
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC,
  FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE,
  FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE,
  FPC_TEARDOWN_L2_GAS,
  FPC_TEARDOWN_DA_GAS,
} from "@aztec-kit/contracts-aztec/fpc-gas-constants";
import { FunctionType } from "@aztec/aztec.js/abi";
import { ArtifactUpload } from "./ArtifactUpload";
import { FunctionSelector } from "./FunctionSelector";
import { FunctionArgsForm, getDefaultArgs, type AliasedAddress } from "./FunctionArgsForm";
import { CalibrationResult } from "./CalibrationResult";

const STEPS = ["Contract Artifact & Address", "Select Function", "Calibration", "Review & Sign Up"];

interface AppSignUpProps {
  fpc: SubscriptionFPCContract;
  adminAddress: AztecAddress;
  onSignedUp?: () => void;
}

export function AppSignUp({ fpc, adminAddress, onSignedUp }: AppSignUpProps) {
  const { wallet, node } = useWallet();
  const {
    contracts: storedContracts,
    senders: storedSenders,
    addContract: addStoredContractAlias,
    removeContract: removeStoredContractAlias,
    addSender: addStoredSenderAlias,
    removeSender: removeStoredSenderAlias,
  } = useAliases();
  const [activeStep, setActiveStep] = useState(0);

  // Step 1: Artifact
  const [artifact, setArtifact] = useState<ContractArtifact | null>(null);

  // Step 2: Function
  const [selectedFunction, setSelectedFunction] = useState<FunctionAbi | null>(null);

  // Step 3: Contract instance
  const [instanceMode, setInstanceMode] = useState<"public" | "compute">("public");
  const [contractAddress, setContractAddress] = useState("");
  const [computeSalt, setComputeSalt] = useState("");
  const [computeDeployer, setComputeDeployer] = useState("");
  const [computeInitializer, setComputeInitializer] = useState<FunctionAbi | null>(null);
  const [computeConstructorArgs, setComputeConstructorArgs] = useState<string[]>([]);
  const [contractInstance, setContractInstance] = useState<ContractInstanceWithAddress | null>(
    null,
  );
  const [contractAlias, setContractAlias] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);

  // Extra contract registrations (for contracts called by the sponsored function).
  // Persisted contracts live in AliasContext; this local state is just the in-flight
  // form for registering a new one.
  const [extraArtifact, setExtraArtifact] = useState<ContractArtifact | null>(null);
  const [extraAddress, setExtraAddress] = useState("");
  const [extraAlias, setExtraAlias] = useState("");
  const [extraRegistering, setExtraRegistering] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);

  // Extra sender registrations (for addresses that need to be known to PXE for tag computation).
  // Persisted senders live in AliasContext; this local state is just the in-flight form.
  const [senderAddress, setSenderAddress] = useState("");
  const [senderAlias, setSenderAlias] = useState("");
  const [senderRegistering, setSenderRegistering] = useState(false);
  const [senderError, setSenderError] = useState<string | null>(null);

  // Step 2: Calibration mode
  const [calibrationMode, setCalibrationMode] = useState<"simulation" | "manual">("simulation");
  const [manualStandaloneGas, setManualStandaloneGas] = useState({
    daGas: "",
    l2Gas: "",
  });
  // Operator override for the `hasPublicCall` flag in manual mode. We seed it
  // from the function's top-level type when the function is picked, but allow
  // flipping it — a top-level-private fn can still enqueue a public call (e.g.
  // via `self.call(...)` into a public fn), and the FPC's pricing depends on
  // the *whole tx*'s regime, not just the entry fn's type.
  const [manualHasPublicCall, setManualHasPublicCall] = useState(false);

  const isPrivateFunction = selectedFunction?.functionType === FunctionType.PRIVATE;

  // Step 2 (simulation): Args
  const [argValues, setArgValues] = useState<string[]>([]);

  // Step 2 (simulation): Calibration
  const [calibrating, setCalibrating] = useState(false);
  const [calibrationResult, setCalibrationResult] = useState<CalibrationData | null>(null);
  const [calibrationError, setCalibrationError] = useState<string | null>(null);

  // Step 5: Sign up
  const [maxFeeFj, setMaxFeeFj] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [maxUsers, setMaxUsers] = useState("16");
  const [configIndex, setConfigIndex] = useState("0");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Aliased addresses available as combo options for address-typed args.
  const aliasedAddresses = useMemo<AliasedAddress[]>(() => {
    const list: AliasedAddress[] = [
      { address: adminAddress.toString(), alias: "admin", kind: "admin" },
    ];
    if (contractInstance) {
      list.push({
        address: contractInstance.address.toString(),
        alias: contractAlias.trim() || artifact?.name || "app",
        kind: "contract",
      });
    }
    for (const c of storedContracts) {
      list.push({ address: c.address, alias: c.alias, kind: "contract" });
    }
    for (const s of storedSenders) {
      list.push({ address: s.address, alias: s.alias, kind: "sender" });
    }
    // Deduplicate by address, preserving first occurrence (admin wins).
    const seen = new Set<string>();
    return list.filter((e) => {
      if (seen.has(e.address)) return false;
      seen.add(e.address);
      return true;
    });
  }, [adminAddress, storedContracts, storedSenders, contractInstance, contractAlias, artifact]);

  // ── Step handlers ───────────────────────────────────────────────────

  const handleArtifactLoaded = (a: ContractArtifact) => {
    setArtifact(a);
    setSelectedFunction(null);
    setContractInstance(null);
    setContractAlias("");
    setCalibrationResult(null);
    // Pre-select the default initializer for "Compute from Params" mode
    const defaultInit = getDefaultInitializer(a) ?? null;
    setComputeInitializer(defaultInit);
    setComputeConstructorArgs(defaultInit ? getDefaultArgs(defaultInit) : []);
  };

  const handleFunctionSelected = (fn: FunctionAbi) => {
    setSelectedFunction(fn);
    setArgValues(getDefaultArgs(fn));
    setCalibrationResult(null);
    // Default the manual `hasPublicCall` toggle from the fn's top-level type.
    // Operator can flip it if the fn enqueues public work from private context.
    setManualHasPublicCall(fn.functionType !== FunctionType.PRIVATE);
    setActiveStep(2);
  };

  const handleRegisterPublic = async () => {
    if (!wallet || !node || !artifact) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      const address = AztecAddress.fromStringUnsafe(contractAddress);
      const instance = await node.getContract(address);
      if (!instance) throw new Error("Contract not found on-chain at this address");
      await wallet.registerContract(instance, artifact);
      setContractInstance(instance);
      setActiveStep(1);
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setRegistering(false);
    }
  };

  const handleRegisterComputed = async () => {
    if (!wallet || !artifact) return;
    setRegistering(true);
    setRegisterError(null);
    try {
      const instance = await getContractInstanceFromInstantiationParams(artifact, {
        salt: new Fr(BigInt(computeSalt || "0")),
        deployer: computeDeployer ? AztecAddress.fromStringUnsafe(computeDeployer) : AztecAddress.ZERO,
        constructorArtifact: computeInitializer ?? undefined,
        constructorArgs: computeConstructorArgs,
      });
      await wallet.registerContract(instance, artifact);
      setContractInstance(instance);
      setContractAddress(instance.address.toString());
      setActiveStep(1);
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "Failed to compute instance");
    } finally {
      setRegistering(false);
    }
  };

  const handleRegisterExtra = async () => {
    if (!wallet || !node || !extraArtifact || !extraAddress) return;
    setExtraRegistering(true);
    setExtraError(null);
    try {
      const address = AztecAddress.fromStringUnsafe(extraAddress);
      const instance = await node.getContract(address);
      if (!instance) throw new Error("Contract not found on-chain at this address");
      await wallet.registerContract(instance, extraArtifact);
      addStoredContractAlias({
        address: extraAddress,
        alias: extraAlias.trim() || extraArtifact.name,
      });
      setExtraArtifact(null);
      setExtraAddress("");
      setExtraAlias("");
    } catch (err) {
      setExtraError(err instanceof Error ? err.message : "Registration failed");
    } finally {
      setExtraRegistering(false);
    }
  };

  const handleRegisterSender = async () => {
    if (!wallet || !senderAddress) return;
    setSenderRegistering(true);
    setSenderError(null);
    try {
      const address = AztecAddress.fromStringUnsafe(senderAddress);
      await wallet.registerSender(address, senderAlias || undefined);
      addStoredSenderAlias({
        address: senderAddress,
        alias: senderAlias.trim() || shortAddress(senderAddress),
      });
      setSenderAddress("");
      setSenderAlias("");
    } catch (err) {
      setSenderError(err instanceof Error ? err.message : "Failed to register sender");
    } finally {
      setSenderRegistering(false);
    }
  };

  const handleCalibrate = async () => {
    if (!wallet || !node || !artifact || !contractInstance || !selectedFunction) return;
    setCalibrating(true);
    setCalibrationError(null);
    try {
      const result = await runCalibration({
        adminWallet: wallet,
        adminAddress,
        fpc: new SubscriptionFPC(fpc),
        artifact,
        contractInstance,
        selectedFunction,
        argValues,
      });
      setCalibrationResult(result);
      setActiveStep(3); // Auto-advance to Review & Sign Up
    } catch (err) {
      setCalibrationError(err instanceof Error ? err.message : "Calibration failed");
    } finally {
      setCalibrating(false);
    }
  };

  const handleManualContinue = () => {
    const standaloneDA = parseInt(manualStandaloneGas.daGas) || 0;
    const standaloneL2 = parseInt(manualStandaloneGas.l2Gas) || 0;

    // The standalone gasLimits already bake in the tx's pricing regime
    // (PUBLIC_TX overhead + AVM rates if the fn has a public call, PRIVATE_TX
    // overhead + private rates otherwise). Sponsoring adds only the FPC's own
    // overhead, which itself depends on whether the sponsored call enqueues
    // a public call — the FPC's internal note ops get repriced at AVM rates
    // when there is one. Pick the matching pre-measured constant.
    const fpcOverheadDA = manualHasPublicCall
      ? FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC
      : FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE;
    const fpcOverheadL2 = manualHasPublicCall
      ? FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC
      : FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE;

    const result: CalibrationData = {
      gasLimits: { daGas: standaloneDA, l2Gas: standaloneL2 },
      subscribeGasLimits: {
        daGas: standaloneDA + fpcOverheadDA,
        l2Gas: standaloneL2 + fpcOverheadL2,
      },
      teardownGasLimits: {
        daGas: FPC_TEARDOWN_DA_GAS,
        l2Gas: FPC_TEARDOWN_L2_GAS,
      },
      hasPublicCall: manualHasPublicCall,
    };
    setCalibrationResult(result);
    setActiveStep(3);
  };

  const handleSimulationDone = () => {
    if (calibrationResult) setActiveStep(3);
  };

  const handleSignUp = async () => {
    if (!selectedFunction || !contractInstance) return;
    setSubmitting(true);
    setSubmitError(null);
    setSuccess(false);
    try {
      const selector = await AztecFunctionSelector.fromNameAndParameters(
        selectedFunction.name,
        selectedFunction.parameters,
      );
      if (!calibrationResult) {
        throw new Error("Calibration must complete before signing up");
      }
      await signUpApp(fpc, adminAddress, {
        appAddress: contractInstance.address,
        selector,
        configIndex: parseInt(configIndex),
        maxUses: parseInt(maxUses),
        maxFee: parseUnits(maxFeeFj, 18),
        maxUsers: parseInt(maxUsers),
        gasLimits: calibrationResult.gasLimits,
        hasPublicCall: calibrationResult.hasPublicCall,
      });
      // Persist the signed-up app as an aliased contract so it's available as
      // an arg pick for future calibrations.
      addStoredContractAlias({
        address: contractInstance.address.toString(),
        alias: contractAlias.trim() || artifact?.name || "app",
      });
      setSuccess(true);
      onSignedUp?.();
      // Reset wizard after a short delay so the success message is visible
      setTimeout(() => {
        setActiveStep(0);
        setArtifact(null);
        setSelectedFunction(null);
        setContractInstance(null);
        setContractAddress("");
        setContractAlias("");
        setArgValues([]);
        setCalibrationResult(null);
        setCalibrationError(null);
        setMaxFeeFj("");
        setConfigIndex("0");
        setMaxUses("1");
        setMaxUsers("16");
        setSuccess(false);
      }, 3000);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Sign-up failed");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <Box data-testid="app-signup" data-active-step={activeStep}>
      <Stepper activeStep={activeStep} orientation="vertical">
        {/* Step 0: Contract Artifact & Address */}
        <Step>
          <StepLabel
            onClick={() => activeStep > 0 && setActiveStep(0)}
            sx={{ cursor: activeStep > 0 ? "pointer" : "default" }}
            optional={
              activeStep > 0 ? (
                <EditIcon sx={{ fontSize: 14, color: "text.secondary" }} />
              ) : undefined
            }
          >
            {STEPS[0]}
          </StepLabel>
          <StepContent>
            {!artifact ? (
              <ArtifactUpload
                onArtifactLoaded={handleArtifactLoaded}
                testId="app-signup-artifact"
              />
            ) : (
              <Box>
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    mb: 2,
                  }}
                >
                  <Chip
                    label={`${artifact.name} (${artifact.functions.length} functions)`}
                    size="small"
                  />
                  <Button
                    size="small"
                    onClick={() => {
                      setArtifact(null);
                      setContractInstance(null);
                      setContractAlias("");
                    }}
                  >
                    Change
                  </Button>
                </Box>

                <ToggleButtonGroup
                  value={instanceMode}
                  exclusive
                  onChange={(_, v) => {
                    if (v) setInstanceMode(v);
                  }}
                  fullWidth
                  size="small"
                  sx={{ mb: 2 }}
                >
                  <ToggleButton value="public">Publicly Deployed</ToggleButton>
                  <ToggleButton value="compute">Compute from Params</ToggleButton>
                </ToggleButtonGroup>

                <TextField
                  fullWidth
                  label="Alias"
                  placeholder={artifact.name}
                  value={contractAlias}
                  onChange={(e) => setContractAlias(e.target.value)}
                  size="small"
                  helperText="Shown in address combos when picking args"
                  sx={{ mb: 2 }}
                  slotProps={{ htmlInput: { "data-testid": "app-signup-contract-alias" } }}
                />

                {instanceMode === "public" && (
                  <Box>
                    <TextField
                      fullWidth
                      label="Contract Address"
                      placeholder="0x..."
                      value={contractAddress}
                      onChange={(e) => setContractAddress(e.target.value)}
                      size="small"
                      sx={{ mb: 2 }}
                      slotProps={{ htmlInput: { "data-testid": "app-signup-contract-address" } }}
                    />
                    <Button
                      fullWidth
                      variant="contained"
                      onClick={handleRegisterPublic}
                      disabled={registering || !contractAddress}
                      data-testid="app-signup-register"
                    >
                      {registering ? <CircularProgress size={20} /> : "Fetch & Register"}
                    </Button>
                  </Box>
                )}

                {instanceMode === "compute" && artifact && (
                  <Box>
                    {/* Initializer selector */}
                    {(() => {
                      const initializers = getAllFunctionAbis(artifact).filter(
                        (fn) => fn.isInitializer,
                      );
                      if (initializers.length === 0) return null;
                      return (
                        <FormControl fullWidth size="small" sx={{ mb: 1 }}>
                          <InputLabel>Constructor</InputLabel>
                          <Select
                            value={computeInitializer?.name ?? ""}
                            label="Constructor"
                            onChange={(e) => {
                              const init = getInitializer(artifact, e.target.value) ?? null;
                              setComputeInitializer(init);
                              setComputeConstructorArgs(init ? getDefaultArgs(init) : []);
                            }}
                          >
                            {initializers.map((fn) => (
                              <MenuItem key={fn.name} value={fn.name}>
                                {fn.name}
                              </MenuItem>
                            ))}
                          </Select>
                        </FormControl>
                      );
                    })()}

                    {/* Constructor args */}
                    {computeInitializer && computeInitializer.parameters.length > 0 && (
                      <Box sx={{ mb: 1 }}>
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ mb: 0.5, display: "block" }}
                        >
                          Constructor arguments
                        </Typography>
                        <FunctionArgsForm
                          fn={computeInitializer}
                          values={computeConstructorArgs}
                          onChange={setComputeConstructorArgs}
                          aliasedAddresses={aliasedAddresses}
                        />
                      </Box>
                    )}

                    <TextField
                      fullWidth
                      label="Salt"
                      placeholder="0 or 0x..."
                      value={computeSalt}
                      onChange={(e) => setComputeSalt(e.target.value)}
                      size="small"
                      sx={{ mb: 1 }}
                    />
                    <TextField
                      fullWidth
                      label="Deployer Address"
                      placeholder="0x... (or leave empty for zero)"
                      value={computeDeployer}
                      onChange={(e) => setComputeDeployer(e.target.value)}
                      size="small"
                      sx={{ mb: 2 }}
                    />
                    <Button
                      fullWidth
                      variant="contained"
                      onClick={handleRegisterComputed}
                      disabled={registering}
                    >
                      {registering ? <CircularProgress size={20} /> : "Compute & Register"}
                    </Button>
                  </Box>
                )}

                {registerError && (
                  <Alert severity="error" sx={{ mt: 1 }} data-testid="app-signup-register-error">
                    {registerError}
                  </Alert>
                )}
                {contractInstance && (
                  <Alert
                    severity="success"
                    sx={{ mt: 1 }}
                    data-testid="app-signup-register-success"
                  >
                    Registered: {shortAddress(contractInstance.address.toString())}
                  </Alert>
                )}
              </Box>
            )}
          </StepContent>
        </Step>

        {/* Step 1: Select Function */}
        <Step>
          <StepLabel
            onClick={() => activeStep > 1 && setActiveStep(1)}
            sx={{ cursor: activeStep > 1 ? "pointer" : "default" }}
            optional={
              activeStep > 1 ? (
                <EditIcon sx={{ fontSize: 14, color: "text.secondary" }} />
              ) : undefined
            }
          >
            {STEPS[1]}
          </StepLabel>
          <StepContent>
            {artifact && (
              <FunctionSelector
                artifact={artifact}
                selectedFunction={selectedFunction}
                onSelect={handleFunctionSelected}
                testIdPrefix="app-signup-function-select"
              />
            )}
          </StepContent>
        </Step>

        {/* Step 2: Calibration */}
        <Step>
          <StepLabel
            onClick={() => activeStep > 2 && setActiveStep(2)}
            sx={{ cursor: activeStep > 2 ? "pointer" : "default" }}
            optional={
              activeStep > 2 ? (
                <EditIcon sx={{ fontSize: 14, color: "text.secondary" }} />
              ) : undefined
            }
          >
            {STEPS[2]}
          </StepLabel>
          <StepContent>
            <ToggleButtonGroup
              value={calibrationMode}
              exclusive
              onChange={(_, v) => {
                if (v) {
                  setCalibrationMode(v);
                  setCalibrationResult(null);
                }
              }}
              fullWidth
              size="small"
              sx={{ mb: 2 }}
            >
              <ToggleButton value="simulation">Simulation</ToggleButton>
              <ToggleButton value="manual">Manual Gas Limits</ToggleButton>
            </ToggleButtonGroup>

            {calibrationMode === "simulation" && (
              <>
                {/* Extra contracts */}
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Register additional contracts called by the sponsored function.
                </Typography>

                {storedContracts.map((ec) => (
                  <Chip
                    key={ec.address}
                    label={`${ec.alias} (${shortAddress(ec.address)})`}
                    onDelete={() => removeStoredContractAlias(ec.address)}
                    size="small"
                    sx={{ mr: 0.5, mb: 0.5 }}
                    data-testid={`app-signup-extra-chip-${ec.alias}`}
                  />
                ))}

                {!extraArtifact ? (
                  <ArtifactUpload
                    onArtifactLoaded={setExtraArtifact}
                    testId="app-signup-extra-artifact"
                  />
                ) : (
                  <Box sx={{ mt: 1 }} data-testid="app-signup-extra-form">
                    <Chip label={extraArtifact.name} size="small" sx={{ mb: 1 }} />
                    <TextField
                      fullWidth
                      label="Contract Address"
                      placeholder="0x..."
                      value={extraAddress}
                      onChange={(e) => setExtraAddress(e.target.value)}
                      size="small"
                      sx={{ mb: 1 }}
                      slotProps={{ htmlInput: { "data-testid": "app-signup-extra-address" } }}
                    />
                    <TextField
                      fullWidth
                      label="Alias"
                      placeholder={extraArtifact.name}
                      value={extraAlias}
                      onChange={(e) => setExtraAlias(e.target.value)}
                      size="small"
                      sx={{ mb: 1 }}
                      slotProps={{ htmlInput: { "data-testid": "app-signup-extra-alias" } }}
                    />
                    <Box sx={{ display: "flex", gap: 1 }}>
                      <Button
                        variant="outlined"
                        size="small"
                        onClick={handleRegisterExtra}
                        disabled={extraRegistering || !extraAddress}
                        startIcon={extraRegistering ? <CircularProgress size={14} /> : <AddIcon />}
                        data-testid="app-signup-extra-register"
                      >
                        Register
                      </Button>
                      <Button
                        size="small"
                        onClick={() => {
                          setExtraArtifact(null);
                          setExtraAddress("");
                          setExtraAlias("");
                          setExtraError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </Box>
                    {extraError && (
                      <Alert severity="error" sx={{ mt: 1 }}>
                        {extraError}
                      </Alert>
                    )}
                  </Box>
                )}

                {/* Sender registration */}
                <Typography variant="body2" color="text.secondary" sx={{ mt: 2, mb: 1 }}>
                  Register senders whose notes the admin PXE needs to be aware of.
                </Typography>

                {storedSenders.map((s) => (
                  <Chip
                    key={s.address}
                    label={`${s.alias} (${shortAddress(s.address)})`}
                    onDelete={() => removeStoredSenderAlias(s.address)}
                    size="small"
                    color="info"
                    variant="outlined"
                    sx={{ mr: 0.5, mb: 0.5 }}
                    data-testid={`app-signup-sender-chip-${s.alias}`}
                  />
                ))}

                <Box sx={{ display: "flex", gap: 1, mt: 1, alignItems: "center" }}>
                  <TextField
                    label="Sender Address"
                    placeholder="0x..."
                    value={senderAddress}
                    onChange={(e) => setSenderAddress(e.target.value)}
                    size="small"
                    sx={{ flex: 2 }}
                    slotProps={{ htmlInput: { "data-testid": "app-signup-sender-address" } }}
                  />
                  <TextField
                    label="Alias"
                    placeholder="optional"
                    value={senderAlias}
                    onChange={(e) => setSenderAlias(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    slotProps={{ htmlInput: { "data-testid": "app-signup-sender-alias" } }}
                  />
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleRegisterSender}
                    disabled={senderRegistering || !senderAddress}
                    startIcon={senderRegistering ? <CircularProgress size={14} /> : <AddIcon />}
                    sx={{ height: 40, whiteSpace: "nowrap" }}
                    data-testid="app-signup-sender-add"
                  >
                    Add
                  </Button>
                </Box>
                {senderError && (
                  <Alert severity="error" sx={{ mt: 1 }} data-testid="app-signup-sender-error">
                    {senderError}
                  </Alert>
                )}

                {/* Function args */}
                {selectedFunction && (
                  <Box sx={{ mt: 2 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                      Function arguments for gas estimation. Modify and re-run if calibration fails.
                    </Typography>
                    <FunctionArgsForm
                      fn={selectedFunction}
                      values={argValues}
                      onChange={setArgValues}
                      aliasedAddresses={aliasedAddresses}
                      testIdPrefix="app-signup-arg"
                    />
                  </Box>
                )}

                {calibrationError && (
                  <Alert severity="error" sx={{ mt: 1 }} data-testid="app-signup-calibration-error">
                    {calibrationError}
                  </Alert>
                )}

                <Box
                  sx={{ display: "flex", gap: 1, mt: 2 }}
                  data-testid="app-signup-calibration"
                  data-calibrated={calibrationResult ? "true" : "false"}
                >
                  <Button
                    variant="contained"
                    onClick={handleCalibrate}
                    disabled={calibrating}
                    sx={{ flex: 1 }}
                    data-testid="app-signup-calibrate"
                  >
                    {calibrating ? (
                      <>
                        <CircularProgress size={20} sx={{ mr: 1 }} />
                        Calibrating...
                      </>
                    ) : calibrationResult ? (
                      "Re-run Calibration"
                    ) : (
                      "Run Calibration"
                    )}
                  </Button>
                  {calibrationResult && (
                    <Button
                      variant="outlined"
                      onClick={handleSimulationDone}
                      sx={{ flex: 1 }}
                      data-testid="app-signup-calibration-continue"
                    >
                      Continue to Review
                    </Button>
                  )}
                </Box>
              </>
            )}

            {calibrationMode === "manual" && selectedFunction && (
              <>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  Enter the gas your function uses in a standalone simulation (without the FPC). The
                  FPC overhead and repricing are added automatically.
                </Typography>

                <Chip
                  label={`${selectedFunction.name} (${isPrivateFunction ? "private" : "public"})`}
                  size="small"
                  color={isPrivateFunction ? "secondary" : "primary"}
                  sx={{ mb: 2 }}
                />

                <FormControlLabel
                  control={
                    <Switch
                      checked={manualHasPublicCall}
                      onChange={(e) => setManualHasPublicCall(e.target.checked)}
                      size="small"
                      data-testid="app-signup-manual-has-public-call"
                    />
                  }
                  label={
                    <Box>
                      <Typography variant="body2">Has public call</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {isPrivateFunction
                          ? "Enable if this private fn enqueues a public call (e.g. via self.call into a public fn). Switches to PUBLIC FPC overhead constants."
                          : "Public fns always run a public phase. Disable only if you know better."}
                      </Typography>
                    </Box>
                  }
                  sx={{
                    mb: 2,
                    alignItems: "flex-start",
                    "& .MuiFormControlLabel-label": { mt: 0.25 },
                  }}
                />

                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mb: 0.5, display: "block" }}
                >
                  Standalone gas limits (from regular simulation)
                </Typography>
                <Box sx={{ display: "flex", gap: 2, mb: 2 }}>
                  <TextField
                    label="DA Gas"
                    value={manualStandaloneGas.daGas}
                    onChange={(e) =>
                      setManualStandaloneGas((prev) => ({
                        ...prev,
                        daGas: e.target.value,
                      }))
                    }
                    size="small"
                    sx={{ flex: 1 }}
                  />
                  <TextField
                    label="L2 Gas"
                    value={manualStandaloneGas.l2Gas}
                    onChange={(e) =>
                      setManualStandaloneGas((prev) => ({
                        ...prev,
                        l2Gas: e.target.value,
                      }))
                    }
                    size="small"
                    sx={{ flex: 1 }}
                  />
                </Box>

                {/* Live breakdown */}
                {(manualStandaloneGas.daGas || manualStandaloneGas.l2Gas) && (
                  <Box
                    sx={{
                      p: 1.5,
                      mb: 2,
                      bgcolor: "rgba(212,255,40,0.05)",
                      border: "1px solid",
                      borderColor: "divider",
                      fontFamily: "monospace",
                      fontSize: "0.75rem",
                    }}
                  >
                    {(() => {
                      const sDA = parseInt(manualStandaloneGas.daGas) || 0;
                      const sL2 = parseInt(manualStandaloneGas.l2Gas) || 0;
                      const overheadDA = manualHasPublicCall
                        ? FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PUBLIC
                        : FPC_SUBSCRIBE_OVERHEAD_DA_GAS_PRIVATE;
                      const overheadL2 = manualHasPublicCall
                        ? FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PUBLIC
                        : FPC_SUBSCRIBE_OVERHEAD_L2_GAS_PRIVATE;
                      const totalDA = sDA + overheadDA;
                      const totalL2 = sL2 + overheadL2;
                      return (
                        <>
                          <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                            <span>Standalone</span>
                            <span>
                              DA={sDA.toLocaleString()} L2={sL2.toLocaleString()}
                            </span>
                          </Box>
                          <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                            <span>
                              + FPC overhead ({manualHasPublicCall ? "public" : "private"})
                            </span>
                            <span>
                              DA=+{overheadDA.toLocaleString()} L2=+{overheadL2.toLocaleString()}
                            </span>
                          </Box>
                          <Box
                            sx={{
                              display: "flex",
                              justifyContent: "space-between",
                              borderTop: "1px solid",
                              borderColor: "divider",
                              mt: 0.5,
                              pt: 0.5,
                              fontWeight: 700,
                            }}
                          >
                            <span>= Total gasLimits</span>
                            <span>
                              DA={totalDA.toLocaleString()} L2={totalL2.toLocaleString()}
                            </span>
                          </Box>
                          <Box sx={{ display: "flex", justifyContent: "space-between" }}>
                            <span> Teardown</span>
                            <span>
                              DA={FPC_TEARDOWN_DA_GAS.toLocaleString()} L2=
                              {FPC_TEARDOWN_L2_GAS.toLocaleString()}
                            </span>
                          </Box>
                        </>
                      );
                    })()}
                  </Box>
                )}

                <Button
                  fullWidth
                  variant="contained"
                  onClick={handleManualContinue}
                  disabled={!manualStandaloneGas.l2Gas}
                >
                  Continue to Review
                </Button>
              </>
            )}
          </StepContent>
        </Step>

        {/* Step 3: Review & Sign Up */}
        <Step>
          <StepLabel>{STEPS[3]}</StepLabel>
          <StepContent>
            {calibrationResult && (
              <>
                <CalibrationResult
                  result={calibrationResult}
                  maxFeeFj={maxFeeFj}
                  onMaxFeeChange={setMaxFeeFj}
                  maxUses={parseInt(maxUses) || 1}
                  maxUsers={parseInt(maxUsers) || 1}
                />

                {/* Sign-up parameters */}
                <Box sx={{ display: "flex", gap: 2, mt: 2, mb: 2 }}>
                  <TextField
                    label="Config Index"
                    type="number"
                    value={configIndex}
                    onChange={(e) => setConfigIndex(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    slotProps={{ htmlInput: { "data-testid": "app-signup-config-index" } }}
                  />
                  <TextField
                    label="Uses / subscription"
                    type="number"
                    value={maxUses}
                    onChange={(e) => setMaxUses(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    slotProps={{ htmlInput: { "data-testid": "app-signup-max-uses" } }}
                  />
                  <TextField
                    label="Users (slots)"
                    type="number"
                    value={maxUsers}
                    onChange={(e) => setMaxUsers(e.target.value)}
                    size="small"
                    sx={{ flex: 1 }}
                    helperText="≥ 1"
                    slotProps={{ htmlInput: { "data-testid": "app-signup-max-users" } }}
                  />
                </Box>

                {submitError && (
                  <Alert severity="error" sx={{ mb: 2 }} data-testid="app-signup-submit-error">
                    {submitError}
                  </Alert>
                )}
                {success && (
                  <Alert severity="success" sx={{ mb: 2 }} data-testid="app-signup-success">
                    App signed up successfully!
                  </Alert>
                )}

                <Box sx={{ display: "flex", gap: 1 }}>
                  <Button
                    variant="outlined"
                    onClick={() => setActiveStep(2)}
                    disabled={submitting}
                    sx={{ flex: 1 }}
                  >
                    Back
                  </Button>
                  <Button
                    variant="contained"
                    onClick={handleSignUp}
                    disabled={submitting || !maxFeeFj}
                    sx={{ flex: 1 }}
                    data-testid="app-signup-submit"
                  >
                    {submitting ? (
                      <>
                        <CircularProgress size={20} sx={{ mr: 1 }} />
                        Signing up...
                      </>
                    ) : (
                      "Sign Up App"
                    )}
                  </Button>
                </Box>
              </>
            )}
          </StepContent>
        </Step>
      </Stepper>
    </Box>
  );
}
