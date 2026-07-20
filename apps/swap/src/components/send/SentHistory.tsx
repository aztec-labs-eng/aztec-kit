import { Box, Typography, IconButton, Snackbar, Chip } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useState } from "react";
import { getSentTransfers, type SentTransfer } from "../../services/sentHistoryService";

interface SentHistoryProps {
  senderAddress: string;
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function StatusChip({ status }: { status: SentTransfer["status"] }) {
  if (status === "confirmed") return null;
  const color = status === "pending" ? "warning" : "error";
  return (
    <Chip label={status} size="small" color={color} variant="outlined" sx={{ fontSize: "0.7em" }} />
  );
}

export function SentHistory({ senderAddress }: SentHistoryProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const transfers = getSentTransfers(senderAddress);

  if (transfers.length === 0) return null;

  const visibleTransfers = expanded ? transfers : transfers.slice(0, 3);
  const hasMore = transfers.length > 3;

  const handleCopy = async (link: string) => {
    await navigator.clipboard.writeText(link);
    setCopied(true);
  };

  return (
    <Box sx={{ mt: 3 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        Sent transfers
      </Typography>
      {visibleTransfers.map((transfer) => (
        <Box
          key={transfer.id}
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            py: 1,
            borderBottom: "1px solid",
            borderColor: "divider",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="body2" color="primary" sx={{ fontWeight: "bold" }}>
              {transfer.amount} {transfer.token === "gc" ? "GC" : "GCP"}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              → {transfer.recipient.slice(0, 8)}...{transfer.recipient.slice(-4)}
            </Typography>
            <StatusChip status={transfer.status} />
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Typography variant="caption" color="text.secondary">
              {timeAgo(transfer.createdAt)}
            </Typography>
            {transfer.link && (
              <IconButton size="small" color="primary" onClick={() => handleCopy(transfer.link)}>
                <ContentCopyIcon fontSize="small" />
              </IconButton>
            )}
          </Box>
        </Box>
      ))}
      {hasMore && (
        <Box sx={{ textAlign: "center", mt: 1 }}>
          <IconButton
            size="small"
            onClick={() => setExpanded(!expanded)}
            sx={{ transform: expanded ? "rotate(180deg)" : "none", transition: "0.2s" }}
          >
            <ExpandMoreIcon />
          </IconButton>
        </Box>
      )}
      <Snackbar
        open={copied}
        autoHideDuration={2000}
        onClose={() => setCopied(false)}
        message="Link copied!"
      />
    </Box>
  );
}
