import { Box, Select, MenuItem, Typography } from "@mui/material";
import type { SelectChangeEvent } from "@mui/material";
import type { NetworkContextValue, NetworkLike } from "./createNetworkContext.tsx";

/**
 * Shared network switcher UI. Apps provide their `useNetwork` hook and can
 * intercept a switch (e.g. show a confirmation dialog, tear down the wallet,
 * or reload the page) via `onBeforeSwitch`.
 *
 * Returning `false` from `onBeforeSwitch` cancels the switch; returning
 * anything else lets it proceed via `switchNetwork`. The callback runs
 * synchronously so the render flow stays predictable.
 *
 * When only one network is available the switcher renders nothing — keeps
 * the UI clean for single-network (dev-only or prod-only) setups.
 */

export interface NetworkSwitcherProps<T extends NetworkLike> {
  useNetwork: () => NetworkContextValue<T>;
  /**
   * Called when the user picks a different network. Receives the next id,
   * the current network, and a `commit` callback that persists the switch
   * via the context.
   *
   * - Not provided: the switch commits immediately.
   * - Provided: the handler decides when (or whether) to call `commit()`.
   *   Use this to show a confirmation dialog, disconnect a wallet, or force
   *   a page reload after persisting.
   */
  onSwitch?: (nextId: string, current: T, commit: () => void) => void;
  /** How to render each network's label in the dropdown. Defaults to `name ?? id`. */
  renderLabel?: (network: T) => string;
  /** Override the test id on the dropdown. */
  testId?: string;
}

export function NetworkSwitcher<T extends NetworkLike & { name?: string }>({
  useNetwork,
  onSwitch,
  renderLabel = (n) => n.name ?? n.id,
  testId = "network-switcher",
}: NetworkSwitcherProps<T>) {
  const { activeNetwork, availableNetworks, switchNetwork } = useNetwork();

  if (availableNetworks.length <= 1) return null;

  const handleChange = (event: SelectChangeEvent<string>) => {
    const nextId = event.target.value;
    if (nextId === activeNetwork.id) return;
    const commit = () => switchNetwork(nextId);
    if (onSwitch) onSwitch(nextId, activeNetwork, commit);
    else commit();
  };

  return (
    <Box sx={{ position: "fixed", top: 16, left: 16, zIndex: 1000 }}>
      <Select
        value={activeNetwork.id}
        onChange={handleChange}
        size="small"
        data-testid={testId}
        sx={{
          backgroundColor: "rgba(18, 18, 28, 0.9)",
          backdropFilter: "blur(10px)",
          color: "text.primary",
          border: "1px solid",
          borderColor: "rgba(212, 255, 40, 0.3)",
          borderRadius: 1,
          minWidth: 140,
          "& .MuiOutlinedInput-notchedOutline": { border: "none" },
          "&:hover": { borderColor: "rgba(212, 255, 40, 0.5)" },
          "&.Mui-focused": { borderColor: "primary.main" },
          "& .MuiSelect-select": { py: 1, px: 1.5 },
        }}
      >
        {availableNetworks.map((net) => (
          <MenuItem key={net.id} value={net.id} data-testid={`${testId}-option-${net.id}`}>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: net.id === activeNetwork.id ? "primary.main" : "text.disabled",
                }}
              />
              <Typography variant="body2">{renderLabel(net)}</Typography>
            </Box>
          </MenuItem>
        ))}
      </Select>
    </Box>
  );
}
