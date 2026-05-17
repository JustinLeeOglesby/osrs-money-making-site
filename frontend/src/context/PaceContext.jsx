import { createContext, useContext, useEffect, useState, useMemo, useCallback } from 'react';
import { PACE_STORAGE_KEY, PACE_PRESETS, DEFAULT_PACE } from '../utils/constants';

// Holds the user's "pace" preset — how many recipe completions per hour
// they typically achieve. Used to convert per-craft profit into a realistic
// gp/hour number on every recipe row.

const PaceContext = createContext({
  pace: DEFAULT_PACE,
  setPace: () => {},
  actionsPerHour: PACE_PRESETS.find((p) => p.key === DEFAULT_PACE).actionsPerHour,
});

export const usePace = () => useContext(PaceContext);

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(PACE_STORAGE_KEY);
    if (raw && PACE_PRESETS.some((p) => p.key === raw)) return raw;
  } catch { /* localStorage unavailable */ }
  return DEFAULT_PACE;
}

export function PaceProvider({ children }) {
  const [pace, setPaceState] = useState(loadFromStorage);

  useEffect(() => {
    try {
      localStorage.setItem(PACE_STORAGE_KEY, pace);
    } catch { /* */ }
  }, [pace]);

  const setPace = useCallback((newPace) => {
    if (PACE_PRESETS.some((p) => p.key === newPace)) setPaceState(newPace);
  }, []);

  const actionsPerHour = useMemo(
    () => PACE_PRESETS.find((p) => p.key === pace)?.actionsPerHour
      ?? PACE_PRESETS.find((p) => p.key === DEFAULT_PACE).actionsPerHour,
    [pace]
  );

  const value = useMemo(
    () => ({ pace, setPace, actionsPerHour }),
    [pace, setPace, actionsPerHour]
  );

  return <PaceContext.Provider value={value}>{children}</PaceContext.Provider>;
}
