// Local duplicate detection — against this browser's history only.
//
// Compares a report with past history entries (localStorage) by normalized
// word-set similarity. It can only see reports triaged in this browser; it
// does NOT check the repository or any server, and it never claims to.
// Short reports need an exact normalized match (a 3-word overlap proves
// nothing); longer reports flag at Jaccard >= 0.6.
//
// Pure functions, no DOM: unit-tested in hidden_files/duplicate-unit-test.mjs.

const DUPLICATE_JACCARD = 0.6
const MIN_TOKENS = 8

export function normalizeReport(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function tokenSet(text) {
  return new Set(normalizeReport(text).split(' ').filter(Boolean))
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const w of a) if (b.has(w)) inter++
  return inter / (a.size + b.size - inter)
}

// Returns { entry, score } for the best match, or null. `entries` are
// history entries as stored by src/history.js (each has .report).
export function findDuplicate(report, entries) {
  const mine = tokenSet(report)
  const normalizedMine = normalizeReport(report)
  let best = null
  for (const e of entries || []) {
    const theirs = tokenSet(e.report || '')
    if (mine.size < MIN_TOKENS || theirs.size < MIN_TOKENS) {
      // Too short to judge by overlap: only an exact match counts.
      if (normalizedMine && normalizedMine === normalizeReport(e.report || '')) {
        return { entry: e, score: 1 }
      }
      continue
    }
    const score = jaccard(mine, theirs)
    if (score >= DUPLICATE_JACCARD && (!best || score > best.score)) {
      best = { entry: e, score }
    }
  }
  return best
}
