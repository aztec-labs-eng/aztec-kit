/**
 * TxNotificationCenter
 * Toast-style notification panel pinned to the bottom-right corner.
 * Shows live transaction progress for embedded wallet operations,
 * including phase status, elapsed time, and a PhaseTimeline breakdown on completion.
 */

import React, { useEffect, useState, useRef, useMemo } from "react";
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Collapse,
  Tooltip,
  CircularProgress,
  Chip,
  keyframes,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import UnfoldLessIcon from "@mui/icons-material/UnfoldLess";
import UnfoldMoreIcon from "@mui/icons-material/UnfoldMore";
import { txProgress, type TxProgressEvent, type PhaseTiming } from "./tx-progress.js";

// ─── Live phase support ───────────────────────────────────────────────────────

interface LivePhaseTiming extends PhaseTiming {
  isLive?: boolean;
}

const ACTIVE_PHASE_COLORS: Record<string, string> = {
  syncing: "#90caf9",
  simulating: "#ce93d8",
  proving: "#f48fb1",
  sending: "#2196f3",
  mining: "#4caf50",
};

const shimmer = keyframes`
  0% { background-position: -400px 0; }
  100% { background-position: 400px 0; }
`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

const formatDurationLong = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} milliseconds`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} seconds`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(1);
  return `${minutes}m ${seconds}s`;
};

const PHASE_LABELS: Record<string, string> = {
  syncing: "Syncing",
  simulating: "Simulating",
  proving: "Proving",
  sending: "Sending",
  mining: "Waiting for confirmation",
  complete: "Complete",
  error: "Failed",
};

const pulse = keyframes`
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
`;

// ─── PhaseTimeline (inline, simplified from demo-wallet) ─────────────────────

function PhaseTimelineBar({ phases }: { phases: LivePhaseTiming[] }) {
  const completedPhases = useMemo(() => phases.filter((p) => !p.isLive), [phases]);
  const livePhase = useMemo(() => phases.find((p) => p.isLive), [phases]);

  const completedDuration = useMemo(
    () => completedPhases.reduce((sum, p) => sum + p.duration, 0),
    [completedPhases],
  );
  const liveDuration = livePhase?.duration ?? 0;
  const totalDuration = completedDuration + liveDuration;

  const miningDuration = useMemo(
    () =>
      completedPhases.filter((p) => p.name === "Mining").reduce((sum, p) => sum + p.duration, 0),
    [completedPhases],
  );

  if (phases.length === 0 || totalDuration === 0) return null;

  const preparingDuration = totalDuration - miningDuration;
  const hasMining = miningDuration > 0;
  const hasLive = !!livePhase;

  return (
    <Box sx={{ width: "100%", mt: 1.5 }}>
      {/* Summary chips */}
      <Box
        sx={{
          display: "flex",
          gap: 0.5,
          mb: 0.5,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {hasMining ? (
          <>
            <Chip
              label={`Preparing: ${formatDuration(preparingDuration)}`}
              size="small"
              sx={{
                height: 18,
                fontSize: "0.6rem",
                fontWeight: 600,
                bgcolor: "#1565c0",
                color: "white",
              }}
            />
            <Chip
              label={`Mining: ${formatDuration(miningDuration)}`}
              size="small"
              sx={{
                height: 18,
                fontSize: "0.6rem",
                fontWeight: 600,
                bgcolor: "#4caf50",
                color: "white",
              }}
            />
            <Chip
              label={`Total: ${formatDuration(totalDuration)}`}
              size="small"
              sx={{ height: 18, fontSize: "0.6rem", fontWeight: 600 }}
            />
          </>
        ) : (
          <Chip
            label={
              hasLive
                ? `Elapsed: ${formatDuration(totalDuration)}`
                : `Total: ${formatDuration(totalDuration)}`
            }
            size="small"
            sx={{ height: 18, fontSize: "0.6rem", fontWeight: 600 }}
          />
        )}
      </Box>

      {/* Timeline bar */}
      <Box
        sx={{
          display: "flex",
          width: "100%",
          height: 14,
          borderRadius: 0.5,
          overflow: "hidden",
          bgcolor: "action.hover",
        }}
      >
        {/* Completed segments (proportional width based on total) */}
        {completedPhases.map((phase, index) => {
          const percentage = (phase.duration / totalDuration) * 100;
          return (
            <Tooltip
              key={phase.name}
              title={
                <Box sx={{ p: 0.5 }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    {phase.name}
                  </Typography>
                  <Typography variant="body2">
                    {formatDurationLong(phase.duration)} ({percentage.toFixed(1)}%)
                  </Typography>
                  {phase.breakdown?.map((item, idx) => {
                    const isChild = item.label.startsWith("  ");
                    return (
                      <Typography
                        key={idx}
                        variant="caption"
                        sx={{
                          display: "block",
                          pl: isChild ? 2.5 : 1,
                          fontWeight: isChild ? 400 : 600,
                          fontSize: isChild ? "0.65rem" : "0.7rem",
                          color: isChild ? "text.secondary" : "text.primary",
                        }}
                      >
                        {item.label.trimStart()}: {formatDuration(item.duration)}
                      </Typography>
                    );
                  })}
                  {phase.details?.map((line, idx) => (
                    <Typography
                      key={`d-${idx}`}
                      variant="caption"
                      sx={{
                        display: "block",
                        pl: line.startsWith("  ") ? 2 : 0,
                        mt: idx === 0 ? 0.5 : 0,
                        fontFamily: "monospace",
                        fontSize: "0.65rem",
                      }}
                    >
                      {line}
                    </Typography>
                  ))}
                </Box>
              }
              arrow
              placement="top"
            >
              <Box
                sx={{
                  width: `${percentage}%`,
                  minWidth: percentage > 0 ? 2 : 0,
                  height: "100%",
                  bgcolor: phase.color,
                  borderRight:
                    index < completedPhases.length - 1 || hasLive
                      ? "1px solid rgba(255,255,255,0.3)"
                      : undefined,
                  transition: "filter 0.2s ease",
                  cursor: "pointer",
                  "&:hover": { filter: "brightness(1.2)" },
                }}
              />
            </Tooltip>
          );
        })}

        {/* Live (shimmer) segment — flex: 1 to fill remaining space */}
        {livePhase && (
          <Tooltip
            title={
              <Box sx={{ p: 0.5 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  {livePhase.name}
                </Typography>
                <Typography variant="body2">
                  {formatDurationLong(livePhase.duration)} (in progress)
                </Typography>
              </Box>
            }
            arrow
            placement="top"
          >
            <Box
              sx={{
                flex: 1,
                minWidth: 40,
                height: "100%",
                background: `linear-gradient(90deg, ${livePhase.color}88 0%, ${livePhase.color} 50%, ${livePhase.color}88 100%)`,
                backgroundSize: "400px 100%",
                animation: `${shimmer} 1.5s infinite linear`,
                cursor: "pointer",
              }}
            />
          </Tooltip>
        )}
      </Box>

      {/* Legend */}
      <Box sx={{ display: "flex", gap: 1, mt: 0.5, flexWrap: "wrap" }}>
        {phases.map((phase) => (
          <Box key={phase.name} sx={{ display: "flex", alignItems: "center", gap: 0.3 }}>
            <Box
              sx={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                bgcolor: phase.color,
                ...(phase.isLive && {
                  animation: `${pulse} 1.2s ease-in-out infinite`,
                }),
              }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.6rem" }}>
              {phase.name}
              {phase.isLive ? " ●" : ""}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// ─── Single Toast ────────────────────────────────────────────────────────────

interface TxToastProps {
  event: TxProgressEvent;
  onDismiss: () => void;
}

function TxToast({ event, onDismiss }: TxToastProps) {
  const isActive = event.phase !== "complete" && event.phase !== "error";

  // For completed events, compute total from recorded phases (stable across refreshes)
  const computeFinalElapsed = () => {
    const fromPhases = event.phases.reduce((sum, p) => sum + p.duration, 0);
    return fromPhases > 0 ? fromPhases : Date.now() - event.startTime;
  };

  // Total wall-clock elapsed since tx start (for header display)
  const [elapsed, setElapsed] = useState(() =>
    isActive ? Date.now() - event.startTime : computeFinalElapsed(),
  );
  // Live elapsed within the *current* phase (resets when phase changes)
  const [phaseElapsed, setPhaseElapsed] = useState(() =>
    isActive ? Date.now() - event.phaseStartTime : 0,
  );
  const [expanded, setExpanded] = useState(true);
  const frozen = useRef(!isActive);

  // Tick elapsed time while active, freeze when done
  useEffect(() => {
    if (!isActive) {
      if (!frozen.current) {
        frozen.current = true;
        setElapsed(computeFinalElapsed());
        setPhaseElapsed(0);
      }
      return;
    }
    frozen.current = false;
    const interval = setInterval(() => {
      setElapsed(Date.now() - event.startTime);
      setPhaseElapsed(Date.now() - event.phaseStartTime);
    }, 200);
    return () => clearInterval(interval);
  }, [isActive, event.startTime, event.phaseStartTime]);

  // Re-initialize elapsed when txId changes (new transaction)
  const prevTxIdRef = useRef(event.txId);
  useEffect(() => {
    if (event.txId !== prevTxIdRef.current) {
      prevTxIdRef.current = event.txId;
      setElapsed(isActive ? Date.now() - event.startTime : computeFinalElapsed());
      setPhaseElapsed(isActive ? Date.now() - event.phaseStartTime : 0);
      frozen.current = !isActive;
    }
  }, [event.txId]);

  const isComplete = event.phase === "complete";
  const isError = event.phase === "error";

  // Build display phases: completed phases + live shimmer phase when active
  const displayPhases: LivePhaseTiming[] = useMemo(() => {
    if (!isActive) return event.phases;
    if (phaseElapsed <= 0 && event.phases.length === 0) return [];
    const liveColor = ACTIVE_PHASE_COLORS[event.phase] ?? "#90caf9";
    const liveName = PHASE_LABELS[event.phase] ?? event.phase;
    return [
      ...event.phases,
      {
        name: liveName,
        duration: phaseElapsed > 0 ? phaseElapsed : 100,
        color: liveColor,
        isLive: true,
      },
    ];
  }, [isActive, event.phases, event.phase, phaseElapsed]);

  return (
    <Paper
      elevation={8}
      sx={{
        width: 340,
        overflow: "hidden",
        border: "1px solid",
        borderColor: isError
          ? "rgba(211, 47, 47, 0.4)"
          : isComplete
            ? "rgba(76, 175, 80, 0.4)"
            : "rgba(212, 255, 40, 0.3)",
        bgcolor: "background.paper",
        transition: "border-color 0.3s ease",
      }}
    >
      {/* Header */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          px: 1.5,
          py: 1,
          gap: 1,
          bgcolor: isError
            ? "rgba(211, 47, 47, 0.08)"
            : isComplete
              ? "rgba(76, 175, 80, 0.08)"
              : "rgba(212, 255, 40, 0.05)",
        }}
      >
        {/* Status indicator */}
        {isComplete ? (
          <CheckCircleOutlineIcon sx={{ fontSize: 20, color: "#4caf50" }} />
        ) : isError ? (
          <ErrorOutlineIcon sx={{ fontSize: 20, color: "error.main" }} />
        ) : (
          <CircularProgress size={16} sx={{ color: "primary.main" }} />
        )}

        {/* Label and phase */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, fontSize: "0.8rem" }}>
            {event.label}
          </Typography>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.7rem" }}>
              {PHASE_LABELS[event.phase] ?? event.phase}
            </Typography>
            {isActive && (
              <Box sx={{ display: "flex", gap: 0.3, ml: 0.5 }}>
                {[0, 1, 2].map((i) => (
                  <Box
                    key={i}
                    sx={{
                      width: 3,
                      height: 3,
                      borderRadius: "50%",
                      bgcolor: "primary.main",
                      animation: `${pulse} 1.5s ease-in-out infinite`,
                      animationDelay: `${i * 0.2}s`,
                    }}
                  />
                ))}
              </Box>
            )}
          </Box>
        </Box>

        {/* Elapsed time */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontSize: "0.7rem", fontFamily: "monospace" }}
        >
          {formatDuration(elapsed)}
        </Typography>

        {/* Expand/collapse */}
        {displayPhases.length > 0 && (
          <IconButton size="small" onClick={() => setExpanded((prev) => !prev)} sx={{ p: 0.25 }}>
            {expanded ? (
              <ExpandLessIcon sx={{ fontSize: 16 }} />
            ) : (
              <ExpandMoreIcon sx={{ fontSize: 16 }} />
            )}
          </IconButton>
        )}

        {/* Dismiss */}
        <IconButton size="small" onClick={onDismiss} sx={{ p: 0.25, color: "text.secondary" }}>
          <CloseIcon sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      {/* Phase timeline breakdown (shown during execution and when complete) */}
      <Collapse in={expanded && displayPhases.length > 0}>
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <PhaseTimelineBar phases={displayPhases} />
        </Box>
      </Collapse>

      {/* Error message */}
      {isError && event.error && (
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <Typography
            variant="caption"
            color="error"
            sx={{ fontSize: "0.7rem", wordBreak: "break-word" }}
          >
            {event.error.length > 200 ? event.error.slice(0, 200) + "..." : event.error}
          </Typography>
        </Box>
      )}
    </Paper>
  );
}

// ─── Notification Center Container ───────────────────────────────────────────

export function TxNotificationCenter({ account }: { account?: string | null }) {
  const [toasts, setToasts] = useState<Map<string, TxProgressEvent>>(new Map());
  const [collapsed, setCollapsed] = useState(false);
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  // Set account scope and load persisted history
  useEffect(() => {
    if (!account) return;
    txProgress.setAccount(account);
    const history = txProgress.loadHistory();
    if (history.length > 0) {
      setToasts((prev) => {
        const next = new Map(prev);
        for (const event of history) {
          if (!next.has(event.txId)) next.set(event.txId, event);
        }
        return next;
      });
    }
  }, [account]);

  useEffect(() => {
    return txProgress.subscribe((event) => {
      setToasts((prev) => {
        const next = new Map(prev);
        next.set(event.txId, event);
        return next;
      });
    });
  }, []);

  const dismiss = (txId: string) => {
    txProgress.dismissPersisted(txId);
    setToasts((prev) => {
      const next = new Map(prev);
      next.delete(txId);
      return next;
    });
  };

  const toastList = Array.from(toasts.entries());

  if (toastList.length === 0) return null;

  const activeCount = toastList.filter(
    ([, e]) => e.phase !== "complete" && e.phase !== "error",
  ).length;

  return (
    <Box
      sx={{
        position: "fixed",
        bottom: 16,
        right: 16,
        zIndex: 1400,
        display: "flex",
        flexDirection: "column-reverse",
        alignItems: "flex-end",
        gap: 1,
        pointerEvents: "none",
        "& > *": { pointerEvents: "auto" },
      }}
    >
      {/* Toast list (rendered first = bottom in column-reverse) */}
      {!collapsed &&
        toastList.map(([txId, event]) => (
          <TxToast key={txId} event={event} onDismiss={() => dismiss(txId)} />
        ))}

      {/* Collapse / expand toggle (rendered last = top in column-reverse) */}
      <Tooltip title={collapsed ? "Show notifications" : "Hide notifications"} placement="left">
        <IconButton
          size="small"
          onClick={() => setCollapsed((prev) => !prev)}
          sx={{
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: activeCount > 0 ? "rgba(212, 255, 40, 0.3)" : "divider",
            "&:hover": { bgcolor: "action.hover" },
            px: 1,
            borderRadius: 1,
            gap: 0.5,
          }}
        >
          {collapsed && (
            <Typography variant="caption" sx={{ fontSize: "0.65rem", color: "text.secondary" }}>
              {toastList.length} tx{toastList.length !== 1 ? "s" : ""}
            </Typography>
          )}
          {collapsed ? (
            <UnfoldMoreIcon sx={{ fontSize: 16 }} />
          ) : (
            <UnfoldLessIcon sx={{ fontSize: 16 }} />
          )}
        </IconButton>
      </Tooltip>
    </Box>
  );
}
