# Inbox worst-case gas experiment — results

Question: after dropping the kit's transport-level `eth_estimateGas` ×3
multiplier (`packages/common/src/bridging/utils.ts`, this branch), is the
built-in 2× Inbox-deposit gas-limit buffer from aztec-packages **#24607**
(`INBOX_DEPOSIT_GAS_LIMIT_BUFFER_PERCENTAGE = 100` in `@aztec/aztec.js` ≥ 5.0.0)
enough to cover the **worst-case** `Inbox.sendL2Message` insert — including the
stale-estimate scenario where the estimate was taken at a cheap tree index and
the tx mines at an expensive one?

**Answer: yes, with margin.** Worst observed insert: **119,450 gas**. Cheapest
estimate observed anywhere in the run: **68,150** → the most adversarial
possible limit under the 2× buffer is 2 × 68,150 = **136,300**, leaving
**+16,850 (~14%) headroom** even when the estimate is maximally stale and the
deposit is a minimal 1-wei transfer. Real kit deposits estimate higher
(~106k in the companion `test-nobuffer-bridge.ts` run), so their real margin is
roughly 2 × 106,391 − ~153k ≈ **+60k**.

## Verified tree structure (from `Inbox.sol` / `FrontierLib.sol`)

- Per-checkpoint incremental **frontier** trees, `HEIGHT = L1_TO_L2_MSG_SUBTREE_HEIGHT = 10`,
  `SIZE = 2^10 = 1024` leaves (not 2048 — the 2048-spaced leaf indices seen in
  earlier bridge runs are **global** indices: `checkpoint × 1024 + in-tree index`).
- `insertLeaf` at in-tree index *i* hashes `trailingOnes(i)` levels: each level
  adds a cold frontier SLOAD + a SHA-256 precompile call, and the completing
  write to `frontier[level]` is zero→nonzero (cold, +17.1k) the first time a
  tree reaches that level. Worst leaf: index 1023 (10 levels).
- When a tree fills, the next `sendL2Message` rolls into a fresh tree
  (`inProgress += 1`) — a fresh-tree first insert is also expensive
  (new `nextIndex` + `frontier[0]` slots: 104,566 observed).

## Method

`scripts/test-worstcase-inbox.ts` (run: `node --experimental-transform-types
scripts/test-worstcase-inbox.ts`) on the kit's in-process local network,
`@aztec/*` 5.0.0, anvil 1.4.1. All deposits are direct viem-signed
`FeeJuicePortal.depositToAztecPublic` txs (1 wei each) from a dedicated
account, **no L2 activity in between**, so in-tree indices fill consecutively —
2,560 successful inserts crossing every power-of-two boundary of ~2.5 trees,
with a fresh `eth_estimateGas` before each survey insert.

## Gas used by cascade level (`trailingOnes(in-tree index)`), 2,559 inserts

| level | count | min     | median  | max     |
|------:|------:|--------:|--------:|--------:|
| 0     | 1280  | 68,150  | 68,162  | 119,450 |
| 1     | 640   | 71,552  | 71,564  | 88,664  |
| 2     | 320   | 74,955  | 74,967  | 92,067  |
| 3     | 160   | 78,358  | 78,370  | 95,470  |
| 4     | 80    | 81,761  | 81,773  | 98,873  |
| 5     | 40    | 85,164  | 85,176  | 102,276 |
| 6     | 20    | 88,568  | 88,580  | 105,680 |
| 7     | 10    | 91,983  | 91,983  | 109,083 |
| 8     | 5     | 95,375  | 112,475 | 112,487 |
| 9     | 2     | 115,880 | 115,880 | 115,880 |
| 10    | 2     | 119,284 | 119,296 | 119,296 |

Clean ladder: **+3,403 gas per level** (steady state), plus a one-time **+17.1k**
the first time each tree writes a given frontier slot (the elevated per-level
maxima), plus fresh-tree/first-ever-deposit effects (level-0 maxima 104,566 /
119,450 — the latter is the first deposit ever, which also pays the portal's
zero→nonzero token-balance slot). Total swing cheap→worst: **51,300 gas**, in
line with the "~40k cascade" the upstream comment warns about.

## The hazard is real: deliberate 1.0× stale-estimate failure (phase C)

At in-tree index **1023** (10-level cascade), a deposit sent with
`gasLimit = 68,150` — the minimum estimate observed during the survey, i.e.
exactly "bare estimate taken at a cheap moment, no buffer" —
**reverted out-of-gas** (status 0x0, 67,810/68,150 gas consumed, leaf **not**
inserted; tx `0x06103265…9706c8`). The fresh estimate at that same moment was
119,284, confirming the failure is purely the staleness of the estimate.

## The 2× buffer fixes it

- **Phase D (same index 1023, worst stale estimate × 2):** `gasLimit = 136,300`
  → success, `gasUsed = 119,296`, margin +17,004.
- **Phase E (kit path):** the branch's actual `bridgeFeeJuice` (transport
  multiplier 1n, built-in 2× buffer only) positioned so its deposit lands at
  in-tree index **511** (9-level cascade): estimate 119,897, sent with
  `gasLimit = 239,794` (exactly 2.000×), `gasUsed = 115,097` → success
  (tx `0x8c98aa12…2627eb`).

## Caveats

- Local anvil, automine, `@aztec/*` 5.0.0 — mainnet gas *pricing* differs but
  gas *usage* of this code path does not.
- The survey uses minimal 1-wei deposits from a pre-approved, pre-funded
  account to make the cheap case as cheap as possible; this makes 68,150 a
  conservative (worst-possible) stale-estimate baseline. The 2× buffer covers
  the worst case whenever `estimate ≥ swing` (51,300), which holds for every
  deposit estimate we have ever observed (min 68,150).
- The absolute worst insert (119,450) was the first-ever deposit into a fresh
  portal — a one-time cold-storage effect, coincidentally ~equal to the
  10-level cascade cost.
- The in-process node's archiver logs benign
  `Local L1 to L2 messages state does not match remote` retry warnings while
  catching up with ~2.5k messages; they do not affect L1 gas measurements.
