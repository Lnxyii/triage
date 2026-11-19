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
