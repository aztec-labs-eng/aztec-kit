/**
 * Transaction Progress Tracking
 * Event-based system for reporting tx lifecycle phases from the embedded wallet.
 * The EmbeddedWallet emits events; the TxNotificationCenter listens and renders toast UI.
 * Completed/errored events are persisted to localStorage, scoped by account address.
 */

export type TxPhase =
  | "syncing"
  | "simulating"
  | "proving"
  | "sending"
  | "mining"
  | "complete"
  | "error";

export interface PhaseTiming {
  name: string;
  duration: number;
  color: string;
  breakdown?: Array<{ label: string; duration: number }>;
  details?: string[];
}

export interface TxProgressEvent {
  txId: string;
  label: string;
  phase: TxPhase;
  startTime: number;
  phaseStartTime: number;
  phases: PhaseTiming[];
  error?: string;
  /** The Aztec L2 tx hash — available from the "sending" phase onward */
  aztecTxHash?: string;
}

type TxProgressListener = (event: TxProgressEvent) => void;

const STORAGE_PREFIX = "aztec_kit_tx_history_";
const MAX_STORED = 50;

class TxProgressEmitter {
  private listeners = new Set<TxProgressListener>();
  private accountKey: string | null = null;

  subscribe(listener: TxProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: TxProgressEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
    if (event.phase === "complete" || event.phase === "error") {
      this.persist(event);
    }
  }

  setAccount(address: string) {
    this.accountKey = `${STORAGE_PREFIX}${address}`;
  }

  loadHistory(): TxProgressEvent[] {
    if (!this.accountKey) return [];
    try {
      const raw = localStorage.getItem(this.accountKey);
      if (!raw) return [];
      const events = JSON.parse(raw) as TxProgressEvent[];
      return events.map((e) => ({ phaseStartTime: e.startTime, ...e }));
    } catch {
      return [];
    }
  }

  dismissPersisted(txId: string) {
    if (!this.accountKey) return;
    try {
      const history = this.loadHistory().filter((e) => e.txId !== txId);
      localStorage.setItem(this.accountKey, JSON.stringify(history));
    } catch {
      /* ignore */
    }
  }

  private persist(event: TxProgressEvent) {
    if (!this.accountKey) return;
    try {
      const history = this.loadHistory();
      const idx = history.findIndex((e) => e.txId === event.txId);
      if (idx >= 0) history[idx] = event;
      else history.push(event);
      const trimmed = history.slice(-MAX_STORED);
      localStorage.setItem(this.accountKey, JSON.stringify(trimmed));
    } catch {
      /* ignore */
    }
  }
}

export const txProgress = new TxProgressEmitter();
