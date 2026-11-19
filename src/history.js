// Triage history, stored only in this browser (localStorage).
// No report text leaves the device except what the user sends to the model.

const KEY = 'triage-history-v1'
const MAX_ENTRIES = 50

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function addHistoryEntry({ report, result }) {
  const entries = loadHistory()
  entries.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    title:
      result.kind === 'full'
        ? result.data.title
        : result.data.summary || report.slice(0, 80),
    severity: result.data.severity,
    engine: result.engine,
    kind: result.kind,
    latencyMs: result.latencyMs,
    report,
    result,
  })
  try {
    localStorage.setItem(KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    // Storage full or unavailable — history is a nice-to-have.
  }
  return entries.slice(0, MAX_ENTRIES)
}

export function clearHistory() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Ignore.
  }
}

export function deleteHistoryEntry(id) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(loadHistory().filter((e) => e.id !== id)),
    )
  } catch {
    // Ignore.
  }
}
