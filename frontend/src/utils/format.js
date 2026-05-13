// Number / colour formatting helpers used across the UI.

export const fmtGp = (n) => {
  if (n == null) return '—';
  return Math.round(n).toLocaleString('en-US');
};

export const profitColor = (p) =>
  p > 0 ? 'var(--green)' : p < 0 ? 'var(--red)' : undefined;
