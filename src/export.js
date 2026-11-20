// Export helpers — pure functions, no DOM: unit-tested in
// hidden_files/export-unit-test.mjs. CSV follows RFC 4180: a field is
// quoted when it contains a comma, quote, or newline, and inner quotes
// are doubled.

export function escapeCsvCell(value) {
  const s = value == null ? '' : String(value)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function csvRows(header, rows) {
  const lines = [header.map(escapeCsvCell).join(',')]
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','))
  return lines.join('\r\n') + '\r\n'
}

// GitHub issue export: a pre-filled issue URL on the public repo, opened
// in a new tab — the user submits it on GitHub, so no token ever enters
// the browser. Browsers and servers cap practical URL length
// (~2,000–8,000 chars), so a very long report would be truncated or
// refused if its Markdown went into ?body= verbatim. The body is
// therefore shortened until the whole URL fits MAX_ISSUE_URL_CHARS, and
// the shortening is disclosed inside the body itself, so the user can
// still open the issue and use Copy as Markdown for the full report.
// Returns { url, truncated } — the UI shows a notice when truncated.
export const MAX_ISSUE_URL_CHARS = 7500

export function buildIssueUrl(repoUrl, title, markdown) {
  const marker =
    '\n\n[...truncated — this report is too long for a GitHub issue URL. Use Copy as Markdown for the complete report.]'
  let t = String(title ?? '')
  let body = String(markdown ?? '')
  let truncated = false
  const makeUrl = (tt, bb) =>
    `${repoUrl}/issues/new?title=${encodeURIComponent(tt)}&body=${encodeURIComponent(bb)}`
  let url = makeUrl(t, body)
  if (url.length > MAX_ISSUE_URL_CHARS) {
    truncated = true
    // Shrink the body first: it is almost always the long part. Each
    // pass cuts 10%; bounded, since the body only shrinks.
    let n = body.length
    let fitted = false
    while (n > 0) {
      const candidate = body.slice(0, n) + marker
      if (makeUrl(t, candidate).length <= MAX_ISSUE_URL_CHARS) {
        body = candidate
        fitted = true
        break
      }
      n = Math.floor(n * 0.9)
    }
    if (!fitted) body = marker.trim()
    url = makeUrl(t, body)
    // A pathological title alone can still overflow: shorten it too.
    while (url.length > MAX_ISSUE_URL_CHARS && t.length > 0) {
      t = t.slice(0, Math.max(0, Math.floor(t.length * 0.9)))
      url = makeUrl(t, body)
    }
  }
  return { url, truncated }
}

// One row per triage result: the fields a developer pastes into a tracker
// or a spreadsheet. Repro steps are joined with " | " so the row stays
// one line.
export function resultToCsv(result) {
  const { kind, data, engine, model, latencyMs } = result
  const header = [
    'kind',
    'severity',
    'title',
    'summary',
    'cvss_score',
    'cvss_vector',
    'confidence',
    'repro_steps',
    'draft_reply',
    'poc_outline',
    'impact',
    'recommendation',
    'engine',
    'model',
    'latency_ms',
    'project_context',
  ]
  const row = [
    kind,
    data.severity,
    kind === 'full' ? data.title : '',
    data.summary,
    kind === 'full' ? data.cvssScore : '',
    kind === 'full' ? data.cvssVector : '',
    data.confidence != null ? data.confidence : '',
    (data.reproSteps || []).join(' | '),
    kind === 'quick' ? data.draftReply : '',
    kind === 'full' ? data.pocOutline : '',
    kind === 'full' ? data.impact : '',
    kind === 'full' ? data.recommendation : '',
    engine,
    model,
    latencyMs,
    result.context || '',
  ]
  return csvRows(header, [row])
}

// Whole-history export: one row per triaged report (the scrubbed text the
// model actually saw — secrets never reach history, so they cannot leak
// through an export either).
export function historyToCsv(entries) {
  const header = [
    'id',
    'at',
    'title',
    'severity',
    'engine',
    'kind',
    'latency_ms',
    'report',
  ]
  const rows = (entries || []).map((e) => [
    e.id,
    e.at,
    e.title,
    e.severity,
    e.engine,
    e.kind,
    e.latencyMs,
    e.report,
  ])
  return csvRows(header, rows)
}
