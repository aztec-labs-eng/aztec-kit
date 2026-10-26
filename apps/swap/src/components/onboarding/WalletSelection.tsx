/**
 * WalletSelection Component
 * Displays list of discovered wallets for user selection, plus an option to continue with the embedded wallet
 */

import {
  Box,
  Typography,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  IconButton,
  Divider,
} from "@mui/material";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { WalletProvider } from "@aztec-labs/wallet-sdk/manager";

interface WalletSelectionProps {
  wallets: WalletProvider[];
  cancelledWalletIds: Set<string>;
  onSelect: (wallet: WalletProvider) => void;
  onRefresh: () => void;
  onUseEmbedded: () => void;
}

export function WalletSelection({
  wallets,
  cancelledWalletIds,
  onSelect,
  onRefresh,
  onUseEmbedded,
}: WalletSelectionProps) {
  return (
    <>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          Choose how to connect:
        </Typography>
        <IconButton
          size="small"
          onClick={onRefresh}
          title="Refresh wallet list"
          sx={{ color: "text.secondary" }}
        >
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ maxHeight: "300px", overflowY: "auto" }}>
        <List sx={{ pt: 0 }}>
          {/* Embedded wallet option */}
          <ListItem disablePadding sx={{ mb: 1 }}>
            <ListItemButton
              onClick={onUseEmbedded}
              sx={{
                border: "1px solid",
                borderColor: "divider",
                borderRadius: 1,
                "&:hover": {
                  borderColor: "primary.main",
                  backgroundColor: "rgba(212, 255, 40, 0.05)",
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: 48 }}>
                <Box
                  sx={{
                    width: 32,
                    height: 32,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backgroundColor: "rgba(212, 255, 40, 0.1)",
                    borderRadius: 1,
                  }}
                >
                  <RocketLaunchIcon sx={{ fontSize: 20, color: "primary.main" }} />
                </Box>
              </ListItemIcon>
              <ListItemText
                primary={
                  <Typography variant="body1" fontWeight={600}>
                    Continue without external wallet
                  </Typography>
                }
                secondary={
                  <Typography variant="caption" color="text.secondary">
                    Use a built-in wallet for this session
                  </Typography>
                }
              />
            </ListItemButton>
          </ListItem>

          {/* Divider between embedded and external wallets */}
          {wallets.length > 0 && (
            <Divider sx={{ my: 1.5 }}>
              <Typography variant="caption" color="text.secondary">
                or connect an external wallet
              </Typography>
            </Divider>
          )}

          {/* External wallet options */}
          {wallets.map((provider) => {
            const isCancelled = cancelledWalletIds.has(provider.id);
            return (
              <ListItem key={provider.id} disablePadding sx={{ mb: 1 }}>
                <ListItemButton
                  onClick={() => onSelect(provider)}
                  disabled={isCancelled}
                  sx={{
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: 1,
                    opacity: isCancelled ? 0.5 : 1,
                    "&:hover": {
                      borderColor: isCancelled ? "divider" : "primary.main",
                      backgroundColor: isCancelled ? "transparent" : "rgba(212, 255, 40, 0.05)",
                    },
                    "&.Mui-disabled": {
                      opacity: 0.5,
                    },
                  }}
                >
                  <ListItemIcon sx={{ minWidth: 48 }}>
                    {provider.icon ? (
                      <Box
                        component="img"
                        src={provider.icon}
                        alt={provider.name}
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: 1,
                          filter: isCancelled ? "grayscale(100%)" : "none",
                        }}
                      />
                    ) : (
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          backgroundColor: "rgba(255, 255, 255, 0.1)",
                          borderRadius: 1,
                        }}
                      >
                        <AccountBalanceWalletIcon
                          sx={{
                            fontSize: 20,
                            color: isCancelled ? "text.disabled" : "primary.main",
                          }}
                        />
                      </Box>
                    )}
                  </ListItemIcon>
                  <ListItemText
                    primary={
                      <Typography
                        variant="body1"
                        fontWeight={600}
                        color={isCancelled ? "text.disabled" : "text.primary"}
                      >
                        {provider.name}
                      </Typography>
                    }
                    secondary={
                      isCancelled ? (
                        <Typography variant="caption" color="text.disabled">
                          Connection cancelled - refresh to retry
                        </Typography>
                      ) : undefined
                    }
                  />
                </ListItemButton>
              </ListItem>
            );
          })}
        </List>
      </Box>
    </>
  );
}
