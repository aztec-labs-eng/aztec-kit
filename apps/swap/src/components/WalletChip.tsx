import { Chip, Box } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";

interface WalletChipProps {
  address: string | null;
  isConnected: boolean;
  onClick: () => void;
  onDisconnect?: () => void;
}

export function WalletChip({ address, isConnected, onClick, onDisconnect }: WalletChipProps) {
  const displayText =
    isConnected && address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Connect wallet";

  const handleDelete = (event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent triggering onClick
    onDisconnect?.();
  };

  return (
    <Box
      sx={{
        position: "fixed",
        top: 16,
        right: 16,
        zIndex: 1000,
      }}
    >
      <Chip
        label={displayText}
        onClick={onClick}
        onDelete={isConnected && onDisconnect ? handleDelete : undefined}
        deleteIcon={<CloseIcon />}
        data-testid="wallet-chip"
        data-connected={isConnected ? "true" : "false"}
        data-address={address ?? ""}
        sx={{
          backgroundColor: "rgba(212, 255, 40, 0.15)",
          border: "1px solid",
          borderColor: "primary.main",
          color: "primary.main",
          fontFamily: isConnected && address ? "monospace" : "inherit",
          fontWeight: 600,
          fontSize: "0.875rem",
          backdropFilter: "blur(10px)",
          cursor: "pointer",
          transition: "all 0.2s ease-in-out",
          "&:hover": {
            backgroundColor: "rgba(212, 255, 40, 0.25)",
            borderColor: "primary.main",
            transform: "scale(1.05)",
            boxShadow: "0 4px 12px rgba(212, 255, 40, 0.3)",
          },
          "& .MuiChip-label": {
            px: 2,
          },
          "& .MuiChip-deleteIcon": {
            color: "primary.main",
            fontSize: "1.2rem",
            "&:hover": {
              color: "primary.main",
            },
          },
        }}
      />
    </Box>
  );
}
