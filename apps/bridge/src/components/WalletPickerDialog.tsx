import {
  Dialog,
  DialogTitle,
  List,
  ListItemButton,
  ListItemAvatar,
  ListItemText,
  Avatar,
  ThemeProvider,
} from "@mui/material";
import { theme } from "../theme";
import type { EIP6963ProviderDetail } from "../services";

interface WalletPickerDialogProps {
  open: boolean;
  /** Wallets discovered via EIP-6963 */
  wallets: EIP6963ProviderDetail[];
  onSelect: (wallet: EIP6963ProviderDetail) => void;
  onClose: () => void;
}

/**
 * Lets the user pick which installed browser wallet to connect with.
 * Wraps itself in the app theme: it is rendered by WalletProvider, which
 * sits above App's ThemeProvider.
 */
export function WalletPickerDialog({ open, wallets, onSelect, onClose }: WalletPickerDialogProps) {
  return (
    <ThemeProvider theme={theme}>
      <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
        <DialogTitle>Select a wallet</DialogTitle>
        <List sx={{ pt: 0, pb: 1 }}>
          {wallets.map((wallet) => (
            <ListItemButton key={wallet.info.rdns} onClick={() => onSelect(wallet)}>
              <ListItemAvatar>
                <Avatar
                  src={wallet.info.icon}
                  alt={wallet.info.name}
                  variant="rounded"
                  sx={{ width: 32, height: 32 }}
                />
              </ListItemAvatar>
              <ListItemText primary={wallet.info.name} />
            </ListItemButton>
          ))}
        </List>
      </Dialog>
    </ThemeProvider>
  );
}
