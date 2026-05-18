import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import {
  RECIPE_ALERTS_STORAGE_KEY,
  RECIPE_ALERTS_STATE_KEY,
  RECIPE_ALERT_THRESHOLD,
} from '../utils/constants';

// Recipe profit alerts.
//
// Two pieces of state, kept separate by sync requirements:
//   1. `items` — the list of recipe names the user has subscribed to. Synced
//      across devices via SyncContext (storage key in SYNCED_KEYS).
//   2. `state` — per-recipe transient data: lastSeenProfit and whether the
//      alert is "currently triggered" (i.e. we've already fired a notification
//      for the current flip-up and are waiting for it to drop back before
//      re-arming). NOT synced — each device tracks its own observation history,
//      so notifications fire on each device the first time *it* observes the
//      flip.
//
// Transition logic (called from App whenever recipe payload updates):
//   For each watched recipe r with current profit p:
//     - If p >= THRESHOLD and not currently triggered:
//         → fire notification, mark triggered
//     - If p < THRESHOLD and currently triggered:
//         → un-trigger (auto-acknowledge, re-arms for the next flip)
//     - Update lastSeenProfit = p

const RecipeAlertsContext = createContext({
  items: [],
  triggered: new Set(),
  isAlerted: () => false,
  isTriggered: () => false,
  toggle: () => {},
  checkAndFireAlerts: () => [],
  notificationPermission: 'default',
  requestNotificationPermission: () => Promise.resolve('default'),
  acknowledgeAll: () => {},
});

export const useRecipeAlerts = () => useContext(RecipeAlertsContext);

function loadItems() {
  try {
    const raw = localStorage.getItem(RECIPE_ALERTS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(RECIPE_ALERTS_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(RECIPE_ALERTS_STATE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

// Fire a browser notification if permission is granted. The `tag` field
// dedupes — if the user hasn't dismissed a prior notification for the same
// recipe, the new one replaces it rather than stacking.
function fireBrowserNotification(recipeName, profit) {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try {
    const n = new Notification('OSRS recipe alert', {
      body: `${recipeName} just flipped profitable (+${profit.toLocaleString()} gp/cast)`,
      icon: '/favicon.ico',
      tag: `recipe-alert-${recipeName}`,
      renotify: true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* Notification constructor may throw on iOS Safari etc.; silent fail */
  }
}

export function RecipeAlertsProvider({ children }) {
  const [items, setItems] = useState(loadItems);
  // Transient per-recipe state, stored in a ref so updates to it don't
  // re-render the whole provider tree on every payload refresh.
  const stateRef = useRef(loadState());
  // Reactive mirror of which recipes are currently triggered. Used by the
  // sidebar badge + alerts modal.
  const [triggered, setTriggered] = useState(() => {
    const s = new Set();
    for (const [name, v] of Object.entries(loadState())) {
      if (v?.currentlyTriggered) s.add(name);
    }
    return s;
  });
  const [notificationPermission, setNotificationPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'denied'
  );

  // Persist items to localStorage on change.
  useEffect(() => {
    try {
      localStorage.setItem(RECIPE_ALERTS_STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* ignore */
    }
  }, [items]);

  const isAlerted = useCallback(
    (name) => items.some((it) => it.name === name),
    [items]
  );

  const isTriggered = useCallback((name) => triggered.has(name), [triggered]);

  const requestNotificationPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return 'denied';
    if (Notification.permission !== 'default') {
      // Already decided — return as-is, don't re-prompt
      setNotificationPermission(Notification.permission);
      return Notification.permission;
    }
    const result = await Notification.requestPermission();
    setNotificationPermission(result);
    return result;
  }, []);

  // Toggle a recipe's alert subscription. If turning ON and this is the
  // user's first alert, also prompt for browser notification permission.
  const toggle = useCallback(
    async (name) => {
      const willAdd = !items.some((it) => it.name === name);
      if (willAdd && items.length === 0 && notificationPermission === 'default') {
        // First alert ever — opportune moment to ask for notification permission.
        // We don't gate the toggle on the response; in-app badge still works
        // without it. The user just won't get OS-level notifications.
        requestNotificationPermission();
      }
      setItems((prev) => {
        if (prev.some((it) => it.name === name)) {
          return prev.filter((it) => it.name !== name);
        }
        return [...prev, { name, addedAt: Date.now() }];
      });
      if (!willAdd) {
        // Removing — also clear any transient state for cleanliness
        const next = { ...stateRef.current };
        delete next[name];
        stateRef.current = next;
        saveState(next);
        setTriggered((prev) => {
          if (!prev.has(name)) return prev;
          const n = new Set(prev);
          n.delete(name);
          return n;
        });
      }
    },
    [items, notificationPermission, requestNotificationPermission]
  );

  // Called from App after every recipes-payload refresh. Returns the list
  // of recipe names that just flipped (for any in-app "just flipped" toasts
  // the UI wants to show).
  const checkAndFireAlerts = useCallback(
    (recipes) => {
      if (!recipes || items.length === 0) return [];
      const watched = new Set(items.map((it) => it.name));
      const state = { ...stateRef.current };
      const justFlipped = [];
      const newlyTriggered = new Set();
      const stillTriggered = new Set();
      let stateChanged = false;

      for (const r of recipes) {
        if (!watched.has(r.name)) continue;
        const profit = r.profit ?? 0;
        const existing = state[r.name] || {};
        const wasTriggered = !!existing.currentlyTriggered;

        if (profit >= RECIPE_ALERT_THRESHOLD) {
          if (!wasTriggered) {
            justFlipped.push({ name: r.name, profit });
            fireBrowserNotification(r.name, profit);
            state[r.name] = {
              lastSeenProfit: profit,
              lastTriggeredAt: Date.now(),
              currentlyTriggered: true,
            };
            stateChanged = true;
            newlyTriggered.add(r.name);
          } else {
            // Already triggered — update last-seen but don't refire
            if (existing.lastSeenProfit !== profit) {
              state[r.name] = { ...existing, lastSeenProfit: profit };
              stateChanged = true;
            }
            stillTriggered.add(r.name);
          }
        } else if (wasTriggered) {
          // Drop back below threshold → auto-acknowledge so the next flip alerts again
          state[r.name] = {
            ...existing,
            lastSeenProfit: profit,
            currentlyTriggered: false,
          };
          stateChanged = true;
        } else {
          if (existing.lastSeenProfit !== profit) {
            state[r.name] = { ...existing, lastSeenProfit: profit };
            stateChanged = true;
          }
        }
      }

      if (stateChanged) {
        stateRef.current = state;
        saveState(state);
      }
      // Recompute the triggered Set from current state
      const next = new Set([...newlyTriggered, ...stillTriggered]);
      setTriggered((prev) => {
        // Avoid React re-render if nothing actually changed
        if (prev.size === next.size && [...prev].every((n) => next.has(n))) return prev;
        return next;
      });
      return justFlipped;
    },
    [items]
  );

  // Manually clear all currently-triggered states (treats them as acknowledged).
  // Used by the alerts modal's "Dismiss all" button.
  const acknowledgeAll = useCallback(() => {
    const next = { ...stateRef.current };
    for (const k of Object.keys(next)) {
      if (next[k]?.currentlyTriggered) {
        next[k] = { ...next[k], currentlyTriggered: false };
      }
    }
    stateRef.current = next;
    saveState(next);
    setTriggered(new Set());
  }, []);

  const value = useMemo(
    () => ({
      items,
      triggered,
      isAlerted,
      isTriggered,
      toggle,
      checkAndFireAlerts,
      notificationPermission,
      requestNotificationPermission,
      acknowledgeAll,
    }),
    [
      items,
      triggered,
      isAlerted,
      isTriggered,
      toggle,
      checkAndFireAlerts,
      notificationPermission,
      requestNotificationPermission,
      acknowledgeAll,
    ]
  );

  return (
    <RecipeAlertsContext.Provider value={value}>
      {children}
    </RecipeAlertsContext.Provider>
  );
}
