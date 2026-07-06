import { Box, Typography } from "@mui/material";

export function FooterInfo() {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 1.5,
        mt: 4,
      }}
    >
      <Typography variant="caption" color="text.secondary">
        Built on
      </Typography>
      <Box
        component="img"
        src="/aztec_symbol_circle.png"
        alt="Aztec Network"
        sx={{
          height: 20,
          width: 20,
          opacity: 0.7,
        }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
        Aztec Network
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ opacity: 0.7 }}>
        {__AZTEC_VERSION__}
      </Typography>
    </Box>
  );
}
