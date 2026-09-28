import { useDropzone } from "react-dropzone";
import { Box, Typography, Button } from "@mui/material";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import { loadContractArtifact, type ContractArtifact } from "@aztec-labs/aztec.js/abi";

interface ArtifactUploadProps {
  onArtifactLoaded: (artifact: ContractArtifact) => void;
  /**
   * Optional prefix for the internal file input's `data-testid`. Used by
   * e2e tests to drive the dropzone via `setInputFiles()`.
   */
  testId?: string;
}

export function ArtifactUpload({ onArtifactLoaded, testId }: ArtifactUploadProps) {
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: async (files) => {
      const file = files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const artifact = loadContractArtifact(JSON.parse(e.target?.result as string));
        onArtifactLoaded(artifact);
      };
      reader.readAsText(file);
    },
    accept: { "application/json": [".json"] },
    multiple: false,
    noDragEventsBubbling: true,
  });

  return (
    <Box
      {...getRootProps()}
      sx={{
        border: "2px dashed",
        borderColor: isDragActive ? "primary.main" : "divider",
        borderRadius: 0,
        p: 4,
        textAlign: "center",
        cursor: "pointer",
        transition: "border-color 0.2s",
        "&:hover": { borderColor: "primary.main" },
      }}
    >
      <input {...getInputProps()} data-testid={testId ?? "artifact-upload-input"} />
      <UploadFileIcon sx={{ fontSize: 48, color: "primary.main", mb: 1 }} />
      <Typography variant="body1" sx={{ mb: 1 }}>
        {isDragActive ? "Drop the artifact here" : "Upload Contract Artifact"}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Drag and drop a compiled contract JSON file, or click to select
      </Typography>
      <Button variant="outlined" size="small">
        Select File
      </Button>
    </Box>
  );
}
