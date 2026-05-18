// Number / colour formatting helpers used across the UI.

export const fmtGp = (n) => {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
};

export const profitColor = (p) =>
  p > 0 ? 'var(--green)' : p < 0 ? 'var(--red)' : undefined;

// Compact relative-time formatter: takes a Unix-seconds timestamp and returns
// "12s", "4m", "2h", "3d". Returns '—' for null/undefined input.
export const fmtAgo = (unixSec) => {
  if (!unixSec || unixSec <= 0) return '—';
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h`;
  return `${Math.floor(ageSec / 86400)}d`;
};

// "Staleness ratio" — how many "typical inter-trade gaps" has it been since
// the last trade? A ratio of 1 = trades happening on schedule; 5+ = several
// trades' worth of silence; 20+ = the item has effectively gone dark.
// Returns null when we can't compute (no timestamp or zero volume → no
// expected cadence).
export const stalenessRatio = (unixSec, hourlyVolume) => {
  if (!unixSec || unixSec <= 0) return null;
  if (!hourlyVolume || hourlyVolume <= 0) return null;
  const expectedGapSec = 3600 / hourlyVolume;
  const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  return ageSec / expectedGapSec;
};

// Convert a staleness ratio into a UI color band. Tunable thresholds.
export const stalenessColor = (ratio) => {
  if (ratio == null) return undefined;
  if (ratio >= 20) return 'var(--red)';
  if (ratio >= 5) return '#f3c54a';
  return 'var(--green)';
};
