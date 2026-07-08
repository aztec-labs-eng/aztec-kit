import { Box, Typography, CircularProgress } from "@mui/material";

interface ExchangeRateDisplayProps {
  exchangeRate: number | null;
  isLoadingRate: boolean;
}

export function ExchangeRateDisplay({ exchangeRate, isLoadingRate }: ExchangeRateDisplayProps) {
  return (
    <Box
      sx={{
        mt: 2,
        p: 2,
        backgroundColor: "background.default",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
      }}
    >
      <Typography variant="body2" color="text.secondary">
        Exchange Rate:
      </Typography>
      {isLoadingRate || exchangeRate === null ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={14} sx={{ color: "primary.main" }} />
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            Loading...
          </Typography>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
          1 GO = {exchangeRate.toFixed(18)} GOP
        </Typography>
      )}
    </Box>
  );
}
