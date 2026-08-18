import { useState } from "react";
import { Chip, Box, Menu, MenuItem, ListItemIcon, ListItemText, Avatar } from "@mui/material";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import LogoutIcon from "@mui/icons-material/Logout";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { shortAddress } from "@aztec-kit/common/ui";
import { useWallet } from "../contexts/WalletContext";

export function WalletChip() {
  const { account, isConnecting, wrongChain, activeWallet, connect, switchAccount, disconnect } =
    useWallet();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);

  const label = account
    ? wrongChain
      ? "Wrong Chain"
      : shortAddress(account)
    : isConnecting
      ? "Connecting..."
      : "Connect Wallet";

  const icon = wrongChain ? (
    <WarningAmberIcon />
  ) : account && activeWallet ? (
    <Avatar
      src={activeWallet.info.icon}
      alt={activeWallet.info.name}
      sx={{ width: 20, height: 20 }}
    />
  ) : (
    <AccountBalanceWalletIcon />
  );

  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (account) {
      setAnchorEl(e.currentTarget);
    } else {
      connect();
    }
  };

  const handleClose = () => setAnchorEl(null);

  return (
    <Box sx={{ position: "fixed", top: 16, right: 16, zIndex: 10 }}>
      <Chip
        icon={icon}
        label={label}
        onClick={handleClick}
        color={account ? (wrongChain ? "warning" : "primary") : "default"}
        variant={account ? "filled" : "outlined"}
        sx={{
          fontWeight: 600,
          fontSize: "0.875rem",
          cursor: "pointer",
          "&:hover": { opacity: 0.85 },
        }}
      />
      <Menu
        anchorEl={anchorEl}
        open={!!anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { mt: 0.5, minWidth: 180 } } }}
      >
        <MenuItem
          onClick={() => {
            handleClose();
            switchAccount();
          }}
        >
          <ListItemIcon>
            <SwapHorizIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Switch Account</ListItemText>
        </MenuItem>
        <MenuItem
          onClick={() => {
            handleClose();
            disconnect();
          }}
        >
          <ListItemIcon>
            <LogoutIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>Disconnect</ListItemText>
        </MenuItem>
      </Menu>
    </Box>
  );
}
