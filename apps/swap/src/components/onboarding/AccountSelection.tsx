/**
 * AccountSelection Component
 * Displays list of accounts for user selection
 */

import { Box, Typography, List, ListItem, ListItemButton, ListItemText } from "@mui/material";
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses";

interface AccountItem {
  item: AztecAddress;
  alias: string;
}

interface AccountSelectionProps {
  accounts: AccountItem[];
  onSelect: (address: AztecAddress) => void;
}

export function AccountSelection({ accounts, onSelect }: AccountSelectionProps) {
  return (
    <>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Select an account to continue:
      </Typography>
      <Box sx={{ maxHeight: "240px", overflowY: "auto" }}>
        <List sx={{ pt: 0 }}>
          {accounts.map((account, index) => {
            const alias = account.alias || `Account ${index + 1}`;
            const addressStr = account.item.toString();

            return (
              <ListItem key={addressStr} disablePadding sx={{ mb: 1 }}>
                <ListItemButton
                  onClick={() => onSelect(account.item)}
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
                  <ListItemText
                    primary={
                      <Typography variant="body1" fontWeight={600}>
                        {alias}
                      </Typography>
                    }
                    secondary={
                      <Typography
                        variant="caption"
                        sx={{
                          fontFamily: "monospace",
                          wordBreak: "break-all",
                        }}
                      >
                        {addressStr}
                      </Typography>
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
