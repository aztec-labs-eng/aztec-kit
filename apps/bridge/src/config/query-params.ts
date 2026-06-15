/**
 * Query parameter parsing for iframe embedding mode.
 *
 * Supported params:
 *   ?recipient=0x...                          — single pre-filled recipient (no amount, set in Step 4)
 *   ?recipients=addr1,amount1;addr2,amount2   — multiple recipients with amounts (FJ, human-readable)
 *   ?network=<id>                             — override the initial network selection
 *   ?embedded=true                            — force embedded wallet (skip external wallet option)
 *
 * Both ?recipient and ?recipients are normalized into the same `recipients` array.
 * When ?recipient is used (no amount), the amount is left as 0 for the user to fill in Step 4.
 */

import { parseUnits } from "viem";

export interface RecipientEntry {
  address: string;
  amount: bigint;
}

export interface QueryParams {
  /** Pre-filled recipients (from ?recipient= or ?recipients=) */
  recipients: RecipientEntry[] | null;
  /** Network id to select on boot */
  network: string | null;
  /** True when the app is running inside an iframe */
  isIframe: boolean;
  /** Force embedded wallet mode (no external wallet option) */
  forceEmbedded: boolean;
  /** Parent origin for postMessage (derived from document.referrer when in iframe) */
  parentOrigin: string | null;
}

let cached: QueryParams | null = null;

/**
 * Parses "addr1,amount1;addr2,amount2" into RecipientEntry[].
 * Amounts are in human-readable FJ (e.g. "1.5" = 1.5 FJ).
 * If amount is omitted, defaults to 0 (user fills in Step 4).
 */
function parseRecipients(raw: string): RecipientEntry[] | null {
  if (!raw) return null;
  try {
    const entries = raw.split(";").map((pair) => {
      const parts = pair.split(",");
      const address = parts[0]?.trim();
      if (!address) throw new Error("missing address");
      const amountStr = parts[1]?.trim();
      const amount = amountStr ? parseUnits(amountStr, 18) : 0n;
      return { address, amount };
    });
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

export function getQueryParams(): QueryParams {
  if (cached) return cached;
  const params = new URLSearchParams(window.location.search);

  // Normalize ?recipient=addr into recipients array
  const recipientParam = params.get("recipient");
  const recipientsParam = params.get("recipients");

  let recipients: RecipientEntry[] | null = null;
  if (recipientsParam) {
    recipients = parseRecipients(recipientsParam);
  } else if (recipientParam) {
    recipients = [{ address: recipientParam.trim(), amount: 0n }];
  }

  const isIframe = window.self !== window.top;
  let parentOrigin: string | null = null;
  if (isIframe && document.referrer) {
    try {
      parentOrigin = new URL(document.referrer).origin;
    } catch {
      /* invalid referrer */
    }
  }

  cached = {
    recipients,
    network: params.get("network"),
    isIframe,
    forceEmbedded: params.get("embedded") === "true",
    parentOrigin,
  };
  return cached;
}
