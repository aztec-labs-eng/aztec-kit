import { Box, TextField, Typography, Autocomplete } from "@mui/material";
import type { FunctionAbi, AbiType } from "@aztec-labs/aztec.js/abi";
import { shortAddress } from "@aztec-kit/common/ui";

export interface AliasedAddress {
  address: string;
  alias: string;
  kind: "admin" | "contract" | "sender";
}

interface FunctionArgsFormProps {
  fn: FunctionAbi;
  values: string[];
  onChange: (values: string[]) => void;
  aliasedAddresses?: AliasedAddress[];
  /** Optional prefix so e2e tests can target each arg input by parameter name. */
  testIdPrefix?: string;
}

function isAddressType(type: AbiType): boolean {
  if (type.kind !== "struct") return false;
  const path = (type as { path?: string }).path ?? "";
  return path.includes("AztecAddress");
}

function defaultForType(type: AbiType): string {
  switch (type.kind) {
    case "field":
      return "0";
    case "boolean":
      return "false";
    case "integer":
      return "0";
    case "struct": {
      if (isAddressType(type)) return "0x" + "0".repeat(64);
      return "0";
    }
    case "array": {
      const inner = type as { type: AbiType; length: number };
      const items = Array.from({ length: inner.length }, () => defaultForType(inner.type));
      return JSON.stringify(items);
    }
    default:
      return "0";
  }
}

function typeLabel(type: AbiType): string {
  switch (type.kind) {
    case "field":
      return "Field";
    case "boolean":
      return "bool";
    case "integer": {
      const t = type as { sign: string; width: number };
      return `${t.sign === "unsigned" ? "u" : "i"}${t.width}`;
    }
    case "struct": {
      const path = (type as { path?: string }).path ?? "";
      return path.split("::").pop() ?? "struct";
    }
    case "array": {
      const t = type as { type: AbiType; length: number };
      return `[${typeLabel(t.type)}; ${t.length}]`;
    }
    default:
      return type.kind;
  }
}

const KIND_LABEL: Record<AliasedAddress["kind"], string> = {
  admin: "Admin",
  contract: "Contract",
  sender: "Sender",
};

export function FunctionArgsForm({
  fn,
  values,
  onChange,
  aliasedAddresses,
  testIdPrefix,
}: FunctionArgsFormProps) {
  const params = fn.parameters;

  if (params.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        This function takes no arguments.
      </Typography>
    );
  }

  const updateValue = (i: number, value: string) => {
    const updated = [...values];
    updated[i] = value;
    onChange(updated);
  };

  const options = aliasedAddresses ?? [];

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
      {params.map((param, i) => {
        const isAddr = isAddressType(param.type);
        const label = `${param.name} (${typeLabel(param.type)})`;
        const value = values[i] ?? "";
        const tid = testIdPrefix ? `${testIdPrefix}-${param.name}` : undefined;

        if (isAddr) {
          const matched = options.find((o) => o.address === value) ?? null;
          return (
            <Autocomplete
              key={param.name}
              freeSolo
              size="small"
              options={options}
              value={matched ?? value}
              groupBy={(o) => (typeof o === "string" ? "" : KIND_LABEL[o.kind])}
              getOptionLabel={(o) =>
                typeof o === "string" ? o : `${o.alias} (${shortAddress(o.address)})`
              }
              isOptionEqualToValue={(o, v) =>
                typeof o !== "string" && typeof v !== "string" && o.address === v.address
              }
              onChange={(_, v) => {
                if (v === null) updateValue(i, "");
                else if (typeof v === "string") updateValue(i, v);
                else updateValue(i, v.address);
              }}
              onInputChange={(_, v, reason) => {
                if (reason === "input") updateValue(i, v);
              }}
              renderInput={(p) => {
                const inputProps = tid ? { ...p.inputProps, "data-testid": tid } : p.inputProps;
                return (
                  <TextField
                    {...p}
                    inputProps={inputProps}
                    fullWidth
                    label={label}
                    placeholder="0x..."
                  />
                );
              }}
            />
          );
        }

        return (
          <TextField
            key={param.name}
            fullWidth
            label={label}
            value={value}
            onChange={(e) => updateValue(i, e.target.value)}
            size="small"
            slotProps={tid ? { htmlInput: { "data-testid": tid } } : undefined}
          />
        );
      })}
    </Box>
  );
}

/** Generate default arg values for a function's parameters */
export function getDefaultArgs(fn: FunctionAbi): string[] {
  return fn.parameters.map((p) => defaultForType(p.type));
}
