// Resolve a comparison MODE into concrete Before/After month pairs for a keyword,
// using the months the API says are actually available for that keyword.
//
// months: [{ key:'YYYY-MM', monthLabel, scanLabel, timestamp, reportId, ... }]
//         sorted oldest → newest.
// Returns: [{ before, after, tag }]  (empty if the keyword lacks two comparable months)

import { slug } from "./dateutil.js";

function pair(before, after) {
  return {
    before,
    after,
    tag: `${before.key}_vs_${after.key}`,
  };
}

export function resolvePairs(months, mode, params = {}) {
  if (!Array.isArray(months) || months.length < 2) return [];

  switch (mode) {
    case "current_vs_previous": {
      const after = months[months.length - 1];
      const before = months[months.length - 2];
      return [pair(before, after)];
    }

    case "since_beginning": {
      const before = months[0];
      const after = months[months.length - 1];
      return [pair(before, after)];
    }

    case "custom": {
      // params.beforeKey / params.afterKey are 'YYYY-MM'. Fall back to nearest
      // available month if the exact one isn't present for this keyword.
      const before = findMonth(months, params.beforeKey) || months[0];
      const after = findMonth(months, params.afterKey) || months[months.length - 1];
      if (before.key === after.key) return [];
      // Ensure before is older than after.
      return [before.key <= after.key ? pair(before, after) : pair(after, before)];
    }

    case "all_consecutive": {
      const out = [];
      for (let i = 1; i < months.length; i++) out.push(pair(months[i - 1], months[i]));
      return out;
    }

    default:
      return [];
  }
}

function findMonth(months, key) {
  if (!key) return null;
  const exact = months.find((m) => m.key === key);
  if (exact) return exact;
  // nearest by key distance
  let best = null;
  let bestDist = Infinity;
  const target = keyToNum(key);
  for (const m of months) {
    const d = Math.abs(keyToNum(m.key) - target);
    if (d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return best;
}

function keyToNum(key) {
  const [y, m] = String(key).split("-").map(Number);
  return y * 12 + (m - 1);
}

// Human label for a resolved pair, used in the UI and zip note.
export function pairLabel(p) {
  return `${p.before.monthLabel} → ${p.after.monthLabel}`;
}

export { slug };
