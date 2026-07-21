import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Box,
  Typography,
  Button,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  CircularProgress,
  Chip,
  Tooltip,
  IconButton,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DownloadIcon from "@mui/icons-material/Download";
import { AztecAddress } from "@aztec/aztec.js/addresses";
import { shortAddress } from "@aztec-kit/common/ui";
import { FunctionSelector } from "@aztec/aztec.js/abi";
import { formatUnits } from "viem";
import type { SubscriptionFPCContract as SubscriptionFPC } from "@aztec-kit/contracts-aztec/artifacts/SubscriptionFPC";
import {
  getSignedUpApps,
  getStoredFPC,
  computeConfigId,
  queryAvailableSeats,
  type SignedUpApp,
} from "../services/fpcService";
import { FeePricingService } from "../services/fee-pricing";
import { useWallet } from "../contexts/WalletContext";

interface SlotInfo {
  available: number | null;
  loading: boolean;
}

interface UsdInfo {
  perTxUsd: number | null;
  totalUsd: number | null;
}

interface AppListProps {
  fpc: SubscriptionFPC;
  fpcAddress: string;
}

function formatFj(raw: string): string {
  const val = formatUnits(BigInt(raw), 18);
  const num = parseFloat(val);
  if (num === 0) return "0";
  if (num < 0.001) return "<0.001";
  return num.toFixed(3);
}

function formatUsd(val: number | null): string {
  if (val == null) return "—";
  if (val < 0.01) return "<$0.01";
  return `$${val.toFixed(2)}`;
}

export function AppList({ fpc, fpcAddress }: AppListProps) {
  const { node, rollupAddress, l1ChainId, l1RpcUrl } = useWallet();
  const [apps, setApps] = useState<SignedUpApp[]>([]);
  const [slotInfo, setSlotInfo] = useState<Record<string, SlotInfo>>({});
  const [usdInfo, setUsdInfo] = useState<Record<string, UsdInfo>>({});

  const pricingService = useMemo(() => {
    const svc = new FeePricingService(l1RpcUrl ?? undefined, l1ChainId ?? undefined);
    if (rollupAddress) svc.init(rollupAddress);
    return svc;
  }, [rollupAddress, l1ChainId, l1RpcUrl]);

  const loadApps = useCallback(() => {
    setApps(getSignedUpApps());
  }, []);

  useEffect(() => {
    loadApps();
  }, [loadApps]);

  // Fetch USD pricing for all apps
  useEffect(() => {
    if (apps.length === 0 || !pricingService.enabled) return;
    let cancelled = false;

    (async () => {
      const results: Record<string, UsdInfo> = {};
      for (const app of apps) {
        const key = `${app.appAddress}:${app.functionSelector}:${app.configIndex}`;
        const estimate = await pricingService.estimateCostUsd(BigInt(app.maxFee));
        if (cancelled) return;
        const perTxUsd = estimate?.costUsd ?? null;
        const totalUsd = perTxUsd != null ? perTxUsd * app.maxUses * app.maxUsers : null;
        results[key] = { perTxUsd, totalUsd };
      }
      if (!cancelled) setUsdInfo(results);
    })();

    return () => {
      cancelled = true;
    };
  }, [apps, pricingService]);

  const refreshSlots = useCallback(async () => {
    if (apps.length === 0 || !node) return;

    const loading: Record<string, SlotInfo> = {};
    for (const app of apps) {
      const key = `${app.appAddress}:${app.functionSelector}:${app.configIndex}`;
      loading[key] = { available: null, loading: true };
    }
    setSlotInfo(loading);

    const results = await Promise.allSettled(
      apps.map(async (app) => {
        const configId = await computeConfigId(
          AztecAddress.fromStringUnsafe(app.appAddress),
          FunctionSelector.fromString(app.functionSelector),
          app.configIndex,
        );
        const available = await queryAvailableSeats(node, fpc.address, configId, app.maxUsers);
        return {
          key: `${app.appAddress}:${app.functionSelector}:${app.configIndex}`,
          available,
        };
      }),
    );

    const updated: Record<string, SlotInfo> = {};
    for (const result of results) {
      if (result.status === "fulfilled") {
        updated[result.value.key] = {
          available: result.value.available,
          loading: false,
        };
      }
    }
    setSlotInfo(updated);
  }, [apps, fpc, node]);

  useEffect(() => {
    if (apps.length > 0) refreshSlots();
  }, [apps.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const buildSubscriptionConfig = (app: SignedUpApp) => {
    const stored = getStoredFPC();
    return {
      fpcAddress,
      fpcSecretKey: stored?.secretKey ?? "",
      configIndex: app.configIndex,
      gasLimits: app.gasLimits,
      hasPublicCall: app.hasPublicCall,
    };
  };

  const handleCopy = async (app: SignedUpApp) => {
    const json = JSON.stringify(buildSubscriptionConfig(app), null, 2);
    await navigator.clipboard.writeText(json);
  };

  const handleDownload = (app: SignedUpApp) => {
    const json = JSON.stringify(buildSubscriptionConfig(app), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fpc-config-${app.configIndex}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (apps.length === 0) {
    return (
      <Box sx={{ textAlign: "center", py: 4 }} data-testid="app-list" data-count={0}>
        <Typography color="text.secondary">
          No apps signed up yet. Use the "Sign Up" tab to register your first app.
        </Typography>
      </Box>
    );
  }

  return (
    <Box data-testid="app-list" data-count={apps.length}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          mb: 2,
        }}
      >
        <Typography variant="h6">Registered Apps</Typography>
        <Button size="small" startIcon={<RefreshIcon />} onClick={refreshSlots}>
          Refresh
        </Button>
      </Box>

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>App Address</TableCell>
              <TableCell>Selector</TableCell>
              <TableCell align="center">Idx</TableCell>
              <TableCell align="center">Uses</TableCell>
              <TableCell align="center">Slots</TableCell>
              <TableCell align="right">Max Fee / Tx</TableCell>
              <TableCell align="right">Total Package</TableCell>
              <TableCell align="center">Config</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {apps.map((app, i) => {
              const key = `${app.appAddress}:${app.functionSelector}:${app.configIndex}`;
              const info = slotInfo[key];
              const usd = usdInfo[key];
              const totalFjRaw = BigInt(app.maxFee) * BigInt(app.maxUses) * BigInt(app.maxUsers);
              return (
                <TableRow
                  key={i}
                  data-testid={`app-list-row-${app.appAddress}-${app.functionSelector}`}
                  data-gas-da={app.gasLimits.daGas}
                  data-gas-l2={app.gasLimits.l2Gas}
                  data-has-public-call={String(app.hasPublicCall)}
                >
                  <TableCell sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>
                    {shortAddress(app.appAddress)}
                  </TableCell>
                  <TableCell sx={{ fontFamily: "monospace", fontSize: "0.75rem" }}>
                    {app.functionSelector}
                  </TableCell>
                  <TableCell align="center">{app.configIndex}</TableCell>
                  <TableCell align="center">{app.maxUses}</TableCell>
                  <TableCell align="center">
                    {info?.loading ? (
                      <CircularProgress size={16} />
                    ) : info?.available != null && info.available >= 0 ? (
                      <Chip
                        label={`${info.available} / ${app.maxUsers}`}
                        size="small"
                        color={info.available > 0 ? "success" : "error"}
                        variant="outlined"
                      />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title={`${formatFj(app.maxFee)} FJ`} arrow>
                      <Typography variant="body2" sx={{ fontSize: "0.8rem" }}>
                        {formatFj(app.maxFee)} FJ
                      </Typography>
                    </Tooltip>
                    <Typography variant="caption" color="text.secondary">
                      {formatUsd(usd?.perTxUsd ?? null)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip
                      title={`${formatFj(totalFjRaw.toString())} FJ (${app.maxUses} uses × ${app.maxUsers} users)`}
                      arrow
                    >
                      <Typography variant="body2" sx={{ fontSize: "0.8rem" }}>
                        {formatFj(totalFjRaw.toString())} FJ
                      </Typography>
                    </Tooltip>
                    <Typography variant="caption" color="text.secondary">
                      {formatUsd(usd?.totalUsd ?? null)}
                    </Typography>
                  </TableCell>
                  <TableCell align="center">
                    <Box sx={{ display: "flex", gap: 0.5, justifyContent: "center" }}>
                      <Tooltip title="Copy subscription config JSON" arrow>
                        <IconButton size="small" onClick={() => handleCopy(app)}>
                          <ContentCopyIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Download subscription config JSON" arrow>
                        <IconButton size="small" onClick={() => handleDownload(app)}>
                          <DownloadIcon sx={{ fontSize: 16 }} />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
