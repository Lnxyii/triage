// Small async/error helpers for the live AI path. Pure — no Firebase
// imports — so they are unit-testable in plain Node (see
// hidden_files/net-unit-test.mjs).

// Race a promise against a timeout: a hung request must never leave the
// Triage button spinning forever. The timeout error deliberately says
// "deadline expired" so the retry + friendly-error maps below treat it
// like any other stalled service call. The underlying operation keeps
// running in the background (the SDK call cannot be aborted); the UI
// just stops waiting for it.
export function withTimeout(promise, ms, label = 'Request') {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out (deadline expired)`)),
      ms,
    )
  })
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    timeout,
  ])
}

// --- Transient-failure retry ------------------------------------------------
// 429 / 503 / 5xx / network failures are retried twice (2 s, then 5 s)
// before the error reaches the user. 400 / 401 / 403 are never retried:
// those are not transient.
export function isRetryableError(err) {
  const msg = String(err?.message || err || '')
  if (/400|401|403|app check|permission-denied|unauthenticated|invalid argument/i.test(msg)) {
    return false
  }
  return /429|quota|503|overloaded|deadline expired|unavailable|500|502|504|failed to fetch|network|offline|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|timed out/i.test(
    msg,
  )
}

// Map a raw SDK failure to a friendly message for the user. Never surface
// internal details (gateway URLs, project IDs, model names, repo files).
export function friendlyTriageError(err) {
  const msg = String(err?.message || err || '')
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'You appear to be offline. Check your connection and try again.'
  }
  if (/failed to fetch|network error|networkerror|load failed|offline|ERR_INTERNET|ERR_NAME_NOT_RESOLVED/i.test(msg)) {
    return 'You appear to be offline. Check your connection and try again.'
  }
  if (/401|403|app check|permission-denied|unauthenticated|invalid app check/i.test(msg)) {
    return 'Authentication failed — please reload the page and try again.'
  }
  if (/429|quota|503|overloaded|deadline expired|unavailable|500|502|504|internal error|timed out/i.test(msg)) {
    return 'The AI service is busy or the quota is exhausted. Try again in a moment.'
  }
  return 'The AI service could not answer right now. Try again, or use demo mode.'
}
