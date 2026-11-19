// Triage UI wiring. All user-facing copy is in English.

import {
  triage,
  demoTriage,
  getEngineStatus,
  prepareOnDeviceModel,
  isFirebaseConfigured,
  truncateForLocal,
  FORCE_LOCAL_MAX_CHARS,
} from './ai.js'
import { routeFor, routeReason, LONG_REPORT_CHARS } from './prompts.js'
import { scrubReport, describeRedactions } from './scrub.js'
import { findDuplicate } from './duplicate.js'
import { resultToCsv, historyToCsv } from './export.js'
import { SAMPLES } from './samples.js'
import { loadHistory, addHistoryEntry, clearHistory, deleteHistoryEntry } from './history.js'

const $ = (id) => document.getElementById(id)

const input = $('report-input')
const charCount = $('char-count')
const routeHint = $('route-hint')
const routeMeter = $('route-meter')
const routeMeterFill = $('route-meter-fill')
const triageBtn = $('triage-btn')
const clearBtn = $('clear-btn')
const configNote = $('config-note')
const engineChip = $('engine-chip')
const engineChipText = $('engine-chip-text')
const nanoStatus = $('nano-status')
const cloudStatus = $('cloud-status')
const modeStatus = $('mode-status')
const prepareBtn = $('prepare-btn')
const prepareNote = $('prepare-note')
const resultEmpty = $('result-empty')
const resultLoading = $('result-loading')
const loadingText = $('loading-text')
const resultBody = $('result-body')
const resultError = $('result-error')
const historyList = $('history-list')
const historyEmpty = $('history-empty')
const historyStats = $('history-stats')
const clearHistoryBtn = $('clear-history-btn')
const footerMode = $('footer-mode')
const footerBuild = $('footer-build')
const inputWarning = $('input-warning')
const scrubToggle = $('scrub-toggle')
const scrubNote = $('scrub-note')
const projectContext = $('project-context')
const forceLocalToggle = $('force-local-toggle')
const historySearch = $('history-search')
const historySeverityFilter = $('history-severity-filter')
const historyExportFormat = $('history-export-format')
const exportHistoryBtn = $('export-history-btn')
const historyFilterNote = $('history-filter-note')

// Project context: optional, stored in this browser only, sent only inside
// the triage prompts the user already sends.
const CONTEXT_KEY = 'triage-project-context'
function loadProjectContext() {
  try {
    return localStorage.getItem(CONTEXT_KEY) || ''
  } catch {
    return ''
  }
}
function saveProjectContext(value) {
  try {
    if (value) localStorage.setItem(CONTEXT_KEY, value)
    else localStorage.removeItem(CONTEXT_KEY)
  } catch {
    // Ignore.
  }
}

// Download helper shared by the .md / .csv / history exports.
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Input cap: pastes longer than this are cut off by the browser, so the
// warning below has to appear well before it.
const MAX_REPORT_CHARS = 20000
const LONG_INPUT_WARN_CHARS = 8000

// GitHub issue export: a pre-filled issue on the public repo, opened in a
// new tab — the user submits it on GitHub, so no token ever enters the
// browser. The repo is live at REPO_URL below; set REPO_LIVE to false to
// disable the button again (e.g. if the repo is ever made private).
const REPO_URL = 'https://github.com/Lnxyii/triage'
const REPO_LIVE = true

function buildIssueUrl(result) {
  const title = `[${result.data.severity}] ${result.kind === 'full' ? result.data.title : result.data.summary}`
  return `${REPO_URL}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(resultToMarkdown(result))}`
}

let lastResult = null
let lastReport = ''
let lastRun = null
let lastNano = 'unsupported'

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const ENGINE_LABEL = {
  on_device: { text: 'On-device · Gemini Nano', cls: 'on-device' },
  in_cloud: { text: 'Cloud · Gemini Flash', cls: 'cloud' },
  demo: { text: 'Demo mode · local rules', cls: 'demo' },
  // Pre-result state when Firebase is configured: cloud styling with the
  // "engine shown per result" text. (Without this key, setChip('cloud')
  // fell back to demo — amber styling with live-AI text.)
  cloud: { text: 'Live AI ready, engine shown per result', cls: 'cloud' },
}

function engineBadge(engine) {
  const label = ENGINE_LABEL[engine] || ENGINE_LABEL.demo
  return `<span class="badge ${label.cls}">${label.text}</span>`
}

function updateRouteHint() {
  const len = input.value.trim().length
  // Routing is decided on the text that will actually be sent: when
  // scrubbing is on, that is the scrubbed text (a few characters shorter,
  // placeholders instead of secret values). The character count still
  // shows what the user typed.
  const effective = scrubToggle.checked
    ? scrubReport(input.value).text
    : input.value
  const route = routeReason(effective)
  // Live scrub preview: what will be redacted before any AI call.
  // Counts are computed regardless of the toggle, so the warning below
  // can say what would be sent as written when scrubbing is off.
  const found = scrubReport(input.value)
  if (found.total > 0 && scrubToggle.checked) {
    scrubNote.textContent = `Sensitive details found: ${describeRedactions(found.redactions)} — redacted before any AI call.`
    scrubNote.classList.remove('warn')
    scrubNote.hidden = false
  } else if (found.total > 0) {
    scrubNote.textContent = `Scrubbing is off — ${describeRedactions(found.redactions)} in this report will be sent as written.`
    scrubNote.classList.add('warn')
    scrubNote.hidden = false
  } else {
    scrubNote.hidden = true
  }
  charCount.textContent = `${len} characters`
  const forceLocal = forceLocalToggle.checked
  if (route.kind === 'full') {
    if (route.reason === 'length' && forceLocal) {
      routeHint.textContent =
        'Route: full report — forced on-device (falls back to cloud if Nano unavailable)'
    } else if (route.reason === 'security') {
      routeHint.textContent =
        lastNano === 'available'
          ? 'Route: full report — security keywords detected (on-device when available, else cloud)'
          : 'Route: full report — security keywords detected (Cloud · Gemini Flash)'
    } else {
      routeHint.textContent = 'Route: full report (Cloud · Gemini Flash)'
    }
  } else {
    routeHint.textContent =
      'Route: quick triage (Gemini Nano when available, else cloud)'
  }
  // Warn well before the hard cap so a long paste is trimmed by choice,
  // not silently cut off by the browser.
  if (len >= MAX_REPORT_CHARS) {
    inputWarning.textContent =
      'Report is at the 20,000-character limit — trim it to the key excerpts.'
    inputWarning.hidden = false
  } else if (len >= LONG_INPUT_WARN_CHARS) {
    inputWarning.textContent =
      'Very long reports may fail or be truncated — consider pasting the key excerpts.'
    inputWarning.hidden = false
  } else {
    inputWarning.hidden = true
  }
  // Dimension string toward the 1200-char full-report threshold (scaleX, never width).
  // Colour is the route signal: green while the report stays on-device,
  // cloud blue once it will switch to the cloud. A full report only stays
  // green when it will actually attempt on-device — a security report with
  // Nano available, or a long report with Force Local on.
  const pct = Math.min(100, (len / LONG_REPORT_CHARS) * 100)
  routeMeterFill.style.transform = `scaleX(${pct / 100})`
  const onDeviceAttempt =
    route.kind === 'quick' ||
    (route.reason === 'security' && lastNano === 'available') ||
    (route.reason === 'length' && forceLocal)
  routeMeterFill.classList.toggle('over', !onDeviceAttempt)
  routeMeter.setAttribute('aria-valuenow', String(Math.min(len, LONG_REPORT_CHARS)))
}

function setChip(engine) {
  const label = ENGINE_LABEL[engine] || ENGINE_LABEL.demo
  engineChip.className = `engine-chip ${label.cls}`
  engineChipText.textContent = label.text
}

function filteredHistoryEntries() {
  const entries = loadHistory()
  const q = historySearch.value.trim().toLowerCase()
  const sev = historySeverityFilter.value
  return entries.filter((e) => {
    if (sev && e.severity !== sev) return false
    if (!q) return true
    return (
      (e.title || '').toLowerCase().includes(q) ||
      (e.severity || '').toLowerCase().includes(q) ||
      (e.report || '').toLowerCase().includes(q)
    )
  })
}

function renderHistory() {
  const entries = loadHistory()
  const shown = filteredHistoryEntries()
  const filtering =
    historySearch.value.trim() !== '' || historySeverityFilter.value !== ''
  historyEmpty.hidden = shown.length > 0
  historyEmpty.textContent =
    entries.length === 0
      ? 'No triaged reports yet.'
      : 'No history matches this filter.'
  if (filtering) {
    historyFilterNote.textContent = `Showing ${shown.length} of ${entries.length} entries`
    historyFilterNote.hidden = false
  } else {
    historyFilterNote.hidden = true
  }
  // Aggregate strip: totals by severity and by engine, from the entries
  // already stored. Real data only — hidden when history is empty.
  if (!entries.length) {
    historyStats.hidden = true
  } else {
    const sevCount = { Critical: 0, High: 0, Medium: 0, Low: 0 }
    let onDevice = 0
    let inCloud = 0
    for (const e of entries) {
      if (sevCount[e.severity] != null) sevCount[e.severity] += 1
      if (e.engine === 'on_device') onDevice += 1
      else if (e.engine === 'in_cloud') inCloud += 1
    }
    const parts = [`${entries.length} triaged`]
    for (const sev of ['Critical', 'High', 'Medium', 'Low']) {
      if (sevCount[sev]) parts.push(`${sevCount[sev]} ${sev}`)
    }
    if (onDevice) parts.push(`${onDevice} on-device`)
    if (inCloud) parts.push(`${inCloud} cloud`)
    historyStats.textContent = parts.join(' · ')
    historyStats.hidden = false
  }
  historyList.innerHTML = shown
    .map((e) => {
      const when = new Date(e.at).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
      return `<li data-id="${e.id}" tabindex="0">
        <span class="severity ${e.severity.toLowerCase()}">${e.severity}</span>
        <span class="history-title">${escapeHtml(e.title)}</span>
        <span class="history-time">${when}, ${ENGINE_LABEL[e.engine]?.text || e.engine}</span>
        <button class="history-delete" data-delete-id="${e.id}" type="button" aria-label="Delete this history entry">×</button>
      </li>`
    })
    .join('')
}

function showState(state) {
  resultEmpty.hidden = state !== 'empty'
  resultLoading.hidden = state !== 'loading'
  resultBody.hidden = state !== 'result'
  resultError.hidden = state !== 'error'
}

function renderResult(result, { duplicate = null } = {}) {
  const { kind, data, engine, model, latencyMs } = result
  const latency =
    latencyMs < 1000 ? `${latencyMs} ms` : `${(latencyMs / 1000).toFixed(1)} s`

  // Privacy line: what the AI actually received. Redaction counts come
  // from the scrubber; the on-device/demo lines state where the text
  // did (not) go. For cloud results the line always says the report was
  // checked and scrubbed locally first — even when nothing was found —
  // so a sensitive report is never silently sent as written.
  const privacyLine = (() => {
    const r = result.redactions || []
    const total = r.reduce((n, x) => n + x.count, 0)
    if (total > 0) {
      return engine === 'in_cloud'
        ? `Privacy: ${total} sensitive ${total === 1 ? 'item' : 'items'} redacted locally before sending to the cloud (${describeRedactions(r)}).`
        : `Privacy: ${total} sensitive ${total === 1 ? 'item' : 'items'} redacted before the AI call (${describeRedactions(r)}).`
    }
    if (engine === 'on_device') return 'Privacy: processed on-device — nothing left this browser.'
    if (engine === 'demo') return 'Privacy: demo mode — nothing was sent anywhere.'
    if (engine === 'in_cloud')
      return 'Privacy: checked and scrubbed locally before sending to the cloud — no sensitive details found.'
    return 'Privacy: no sensitive details found in this report.'
  })()

  let html = ''
  // Local duplicate warning: similarity is checked against this browser's
  // history only — never the whole repository. Names the matching entry.
  if (duplicate) {
    const when = new Date(duplicate.entry.at).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
    html += `<p class="fineprint warn duplicate-warning">Possible duplicate — similar to “${escapeHtml(duplicate.entry.title)}” triaged on ${when}. This check only covers reports stored in this browser's history, not the whole repository.</p>`
  }

  html += `<div class="result-head">
    ${engineBadge(engine)}
    <span class="severity ${data.severity.toLowerCase()}">${data.severity}</span>
    <span class="latency">${latency} · ${escapeHtml(model)}</span>
  </div>
  <p class="fineprint">${privacyLine}</p>
  ${result.context ? `<p class="fineprint">Project context: ${escapeHtml(result.context)}</p>` : ''}
  ${result.truncated ? `<p class="fineprint warn">Forced on-device: report truncated to ${FORCE_LOCAL_MAX_CHARS.toLocaleString()} characters (from ${Number(result.originalLength).toLocaleString()}) for the on-device model.</p>` : ''}
  ${result.forceLocalRequested && engine === 'in_cloud' ? '<p class="fineprint warn">On-device was requested but is unavailable on this device — this report was processed in the cloud instead.</p>' : ''}`

  if (kind === 'full') {
    // A CVSS score of 0 with vector "n/a" means "not a security issue", not
    // "perfectly secure": show a neutral line instead of a green 0 / 10 chip.
    const isSecurity =
      data.cvssVector && data.cvssVector.trim().toLowerCase() !== 'n/a'
    const cvssHtml = isSecurity
      ? (() => {
          // CVSS chip: 0–3.9 green, 4–6.9 amber, 7–8.9 orange, 9–10 red.
          const score = Number(data.cvssScore)
          const cvssCls = Number.isFinite(score)
            ? score >= 9
              ? 'critical'
              : score >= 7
                ? 'high'
                : score >= 4
                  ? 'medium'
                  : 'low'
            : 'none'
          return `<p><span class="cvss-chip cvss-${cvssCls}">${escapeHtml(String(data.cvssScore))} / 10</span>
          <span class="fineprint"> ${escapeHtml(data.cvssVector)}</span></p>`
        })()
      : '<p class="fineprint">Not a security issue — no CVSS score.</p>'
    html += `<h3>${escapeHtml(data.title)}</h3>
    <p>${escapeHtml(data.summary)}</p>
    <h4>CVSS</h4>
    ${cvssHtml}
    ${data.confidence != null ? `<p class="fineprint">Severity confidence: ${Math.round(data.confidence * 100)}%</p>` : ''}
    <h4>Reproduction steps</h4>
    ${data.reproSteps.length ? `<ol>${data.reproSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<p>No steps could be inferred.</p>'}
    <h4>Proof-of-concept outline</h4>
    <p>${escapeHtml(data.pocOutline)}</p>
    <h4>Impact</h4>
    <p>${escapeHtml(data.impact)}</p>
    <h4>Recommendation</h4>
    <p>${escapeHtml(data.recommendation)}</p>`
  } else {
    html += `<p>${escapeHtml(data.summary)}</p>
    <h4>Reproduction steps</h4>
    ${data.reproSteps.length ? `<ol>${data.reproSteps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>` : '<p>No steps could be inferred from the report.</p>'}
    <h4>Draft reply</h4>
    <p class="draft">${escapeHtml(data.draftReply)}</p>
    ${data.confidence != null ? `<p class="fineprint">Severity confidence: ${Math.round(data.confidence * 100)}%</p>` : ''}`
  }

  html += `<div class="result-actions">
    ${kind === 'quick' ? '<button class="btn secondary" id="full-report-btn">Generate full report</button>' : ''}
    <button class="btn ghost" id="copy-json-btn">Copy result JSON</button>
    <button class="btn ghost" id="copy-md-btn">Copy as Markdown</button>
    <button class="btn ghost" id="download-md-btn">Download .md</button>
    <button class="btn ghost" id="export-csv-btn">Export CSV</button>
    <button class="btn ghost" id="issue-btn" ${REPO_LIVE ? '' : 'disabled'}>Create GitHub Issue</button>
  </div>
  ${REPO_LIVE ? '' : '<p class="fineprint">GitHub issue export unlocks once the public repo is live.</p>'}`


  resultBody.innerHTML = html
  showState('result')

  const fullBtn = $('full-report-btn')
  if (fullBtn) {
    fullBtn.addEventListener('click', () => runTriage({ forceFull: true }))
  }
  $('copy-json-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2))
      $('copy-json-btn').textContent = 'Copied ✓'
    } catch {
      $('copy-json-btn').textContent = 'Copy failed'
    }
  })
  $('copy-md-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(resultToMarkdown(lastResult))
      $('copy-md-btn').textContent = 'Copied ✓'
    } catch {
      $('copy-md-btn').textContent = 'Copy failed'
    }
  })
  $('download-md-btn').addEventListener('click', () => {
    downloadBlob(
      resultToMarkdown(lastResult),
      `triage-${lastResult.data.severity.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.md`,
      'text/markdown',
    )
    $('download-md-btn').textContent = 'Downloaded ✓'
  })
  $('export-csv-btn').addEventListener('click', () => {
    downloadBlob(
      resultToCsv(lastResult),
      `triage-${lastResult.data.severity.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`,
      'text/csv',
    )
    $('export-csv-btn').textContent = 'Exported ✓'
  })
  const issueBtn = $('issue-btn')
  if (issueBtn && REPO_LIVE) {
    issueBtn.addEventListener('click', () => {
      window.open(buildIssueUrl(lastResult), '_blank', 'noopener')
    })
  }
}

function resultToMarkdown(result) {
  const { kind, data, engine, model, latencyMs } = result
  const lines = []
  if (kind === 'full') {
    lines.push(`# ${data.title}`, '')
    lines.push(`Severity: ${data.severity}`)
    if (data.cvssVector && data.cvssVector.trim().toLowerCase() !== 'n/a') {
      lines.push(`CVSS: ${data.cvssScore} / 10 (${data.cvssVector})`)
    } else {
      lines.push('CVSS: not a security issue')
    }
    if (data.confidence != null) {
      lines.push(`Severity confidence: ${Math.round(data.confidence * 100)}%`)
    }
    if (result.context) lines.push(`Project context: ${result.context}`)
    lines.push('', data.summary, '', '## Reproduction steps', '')
    for (const s of data.reproSteps) lines.push(`- ${s}`)
    lines.push('', '## Proof-of-concept outline', '', data.pocOutline)
    lines.push('', '## Impact', '', data.impact)
    lines.push('', '## Recommendation', '', data.recommendation)
  } else {
    lines.push(`# Triage: ${data.severity}`, '')
    lines.push(`Severity: ${data.severity}`)
    if (data.confidence != null) {
      lines.push(`Severity confidence: ${Math.round(data.confidence * 100)}%`)
    }
    if (result.context) lines.push(`Project context: ${result.context}`)
    lines.push('', data.summary, '', '## Reproduction steps', '')
    for (const s of data.reproSteps) lines.push(`- ${s}`)
    lines.push('', '## Draft reply', '', data.draftReply)
  }
  lines.push(
    '',
    `---`,
    `Triaged by ${engine === 'on_device' ? 'Gemini Nano (on-device)' : engine === 'in_cloud' ? 'Gemini Flash (cloud)' : 'Triage demo mode'} (${model}) in ${latencyMs} ms.`,
  )
  const reds = result.redactions || []
  const redTotal = reds.reduce((n, x) => n + x.count, 0)
  if (redTotal > 0) {
    lines.push(
      `Privacy: ${redTotal} sensitive ${redTotal === 1 ? 'item' : 'items'} redacted before the AI call (${describeRedactions(reds)}).`,
    )
  }
  return lines.join('\n')
}

function renderError(message) {
  resultError.innerHTML = `<p><strong>Triage failed.</strong> ${escapeHtml(message)}</p>
    <div class="result-actions">
      <button class="btn secondary" id="retry-btn">Retry</button>
      <button class="btn ghost" id="demo-fallback-btn">Try demo mode instead</button>
    </div>`
  showState('error')
  $('retry-btn').addEventListener('click', () => {
    runTriage(lastRun || {})
  })
  $('demo-fallback-btn').addEventListener('click', () => {
    // Demo mode is the local-rules path: run it directly.
    runTriage({ demoOnly: true })
  })
}

async function runTriage({ forceFull = false, demoOnly = false } = {}) {
  const report = input.value.trim()
  if (!report) {
    input.focus()
    return
  }
  lastRun = { forceFull, demoOnly }
  lastReport = report
  const forceLocal = forceLocalToggle.checked
  const context = projectContext.value.trim()
  triageBtn.disabled = true
  showState('loading')
  loadingText.textContent = forceFull
    ? 'Generating full report in the cloud…'
    : 'Triaging…'
  try {
    let result
    if (demoOnly) {
      // Demo mode runs the same scrub as the live path, so the privacy
      // line and the stored history match what a live call would see.
      // Force Local truncation applies here too, so the note is honest.
      const scrubbed = scrubToggle.checked
        ? scrubReport(report)
        : { text: report, redactions: [], total: 0 }
      const started = performance.now()
      let text = scrubbed.text
      let truncated = false
      let originalLength = text.length
      if (forceLocal) {
        const t = truncateForLocal(text)
        text = t.text
        truncated = t.truncated
        originalLength = t.originalLength
      }
      const kind = forceFull || routeFor(text) === 'full' ? 'full' : 'quick'
      result = {
        kind,
        data: demoTriage(text, kind),
        report: text,
        redactions: scrubbed.redactions,
        engine: 'demo',
        model: 'local rules (no AI)',
        latencyMs: Math.round(performance.now() - started),
        context,
        forceLocalRequested: forceLocal,
        truncated,
        originalLength,
      }
    } else {
      result = await triage(report, {
        forceFull,
        scrub: scrubToggle.checked,
        context,
        forceLocal,
        onRetry: (attempt) => {
          loadingText.textContent = `Retrying… (attempt ${attempt + 1} of 3)`
        },
      })
    }
    lastResult = result
    // Duplicate check runs against the history BEFORE this entry is added,
    // so the new result never matches itself.
    const duplicate = findDuplicate(result.report, loadHistory())
    renderResult(result, { duplicate })
    // History stores the scrubbed text — the text the model actually
    // saw — so secrets never reach localStorage either.
    addHistoryEntry({ report: result.report, result })
    renderHistory()
    setChip(result.engine)
  } catch (err) {
    renderError(err?.message || String(err))
  } finally {
    triageBtn.disabled = false
  }
}

async function refreshEngineStatus() {
  const status = await getEngineStatus()
  lastNano = status.nano
  const nanoLabels = {
    available: 'Available ✓',
    downloading: 'Downloading…',
    downloadable: 'Ready to download',
    unavailable: 'Not available — cloud fallback in use',
    unsupported: 'Not supported by this browser',
  }
  nanoStatus.textContent = nanoLabels[status.nano] || status.nano
  nanoStatus.className = status.nano === 'available' ? 'ok' : ''
  cloudStatus.textContent = status.firebaseConfigured
    ? `Configured (${status.cloudModel})`
    : 'Not configured, demo mode'
  cloudStatus.className = status.firebaseConfigured ? 'ok' : 'bad'
  modeStatus.textContent = status.mode

  // The button only does something when the model can actually be prepared:
  // downloading or downloadable. When Nano is unavailable or unsupported the
  // button stays disabled and the note says why, instead of an active button
  // that silently does nothing.
  prepareBtn.disabled =
    !status.firebaseConfigured ||
    status.nano === 'available' ||
    status.nano === 'unavailable' ||
    status.nano === 'unsupported'
  prepareBtn.textContent =
    status.nano === 'available'
      ? 'On-device model ready ✓'
      : 'Prepare on-device model'
  // Say why the button is disabled instead of leaving a pale button.
  if (!status.firebaseConfigured) {
    prepareNote.textContent =
      'Unavailable: Firebase is not configured — the app runs in demo mode. Ask the site owner to connect a Firebase project to enable live AI.'
  } else if (status.nano === 'available') {
    prepareNote.textContent = 'The on-device model is ready on this device.'
  } else if (status.nano === 'downloading') {
    prepareNote.textContent = 'The on-device model is downloading…'
  } else if (status.nano === 'downloadable') {
    prepareNote.textContent = 'The on-device model can be downloaded on this device.'
  } else {
    prepareNote.textContent =
      'On-device is not available in this browser — quick triage will use the cloud.'
  }

  if (!status.firebaseConfigured) {
    configNote.textContent =
      'Demo mode: Firebase is not configured yet, so triage runs on local rules (no AI). Ask the site owner to connect a Firebase project to enable live AI.'
    configNote.classList.add('warn')
    footerMode.textContent = 'Running in demo mode until Firebase is connected.'
  } else {
    configNote.textContent = ''
    footerMode.textContent = ''
  }
  // One call sets both class and text from ENGINE_LABEL, so they can never
  // disagree again.
  setChip(status.firebaseConfigured ? 'cloud' : 'demo')
  // The route hint depends on Nano availability (security reports run
  // on-device when it is available), so refresh it once status is known.
  updateRouteHint()
}

// --- Wire up ---------------------------------------------------------------

input.addEventListener('input', updateRouteHint)
// Ctrl+Enter (Cmd+Enter on macOS) runs Triage without leaving the keyboard.
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    runTriage()
  }
})
scrubToggle.addEventListener('change', updateRouteHint)
forceLocalToggle.addEventListener('change', updateRouteHint)
projectContext.addEventListener('input', () =>
  saveProjectContext(projectContext.value.trim()),
)
historySearch.addEventListener('input', renderHistory)
historySeverityFilter.addEventListener('change', renderHistory)
exportHistoryBtn.addEventListener('click', () => {
  const entries = loadHistory()
  const stamp = new Date().toISOString().slice(0, 10)
  if (historyExportFormat.value === 'csv') {
    downloadBlob(historyToCsv(entries), `triage-history-${stamp}.csv`, 'text/csv')
  } else {
    downloadBlob(
      JSON.stringify(entries, null, 2),
      `triage-history-${stamp}.json`,
      'application/json',
    )
  }
  exportHistoryBtn.textContent = 'Exported ✓'
  setTimeout(() => {
    exportHistoryBtn.textContent = 'Export history'
  }, 2000)
})

triageBtn.addEventListener('click', () => runTriage())
clearBtn.addEventListener('click', () => {
  input.value = ''
  updateRouteHint()
  showState('empty')
  input.focus()
})

prepareBtn.addEventListener('click', async () => {
  prepareBtn.disabled = true
  prepareBtn.textContent = 'Preparing…'
  try {
    await prepareOnDeviceModel((p) => {
      prepareBtn.textContent = `Downloading model… ${Math.round(p * 100)}%`
    })
    // initializeDeviceModel can resolve without effect on a browser where
    // Nano is unavailable; re-check the real status instead of assuming.
    const status = await getEngineStatus()
    await refreshEngineStatus()
    if (status.nano !== 'available') {
      prepareNote.textContent =
        'On-device model could not be prepared on this device; cloud fallback will be used.'
    }
  } catch {
    // Never surface the raw SDK error here; the note says what happened.
    await refreshEngineStatus()
    prepareNote.textContent =
      'On-device model could not be prepared on this device; cloud fallback will be used.'
  }
})

clearHistoryBtn.addEventListener('click', () => {
  clearHistory()
  renderHistory()
})

historyList.addEventListener('click', (event) => {
  const deleteBtn = event.target.closest('[data-delete-id]')
  if (deleteBtn) {
    deleteHistoryEntry(deleteBtn.dataset.deleteId)
    renderHistory()
    return
  }
  const li = event.target.closest('li[data-id]')
  if (!li) return
  const entry = loadHistory().find((e) => e.id === li.dataset.id)
  if (!entry) return
  // Never silently throw away a report the user is still typing.
  if (
    input.value.trim() &&
    input.value.trim() !== entry.report.trim() &&
    !window.confirm('Replace the current unsaved report with this history entry?')
  ) {
    return
  }
  input.value = entry.report
  updateRouteHint()
  lastResult = entry.result
  renderResult(entry.result)
  setChip(entry.result.engine)
  document
    .querySelector('.result-card')
    .scrollIntoView({ behavior: 'smooth', block: 'start' })
})

historyList.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const li = event.target.closest('li[data-id]')
  if (!li) return
  event.preventDefault()
  li.click()
})

// Sample buttons.
const sampleButtons = $('sample-buttons')
for (const sample of SAMPLES) {
  const btn = document.createElement('button')
  btn.className = 'sample-btn'
  btn.type = 'button'
  btn.textContent = sample.label
  btn.addEventListener('click', () => {
    input.value = sample.text
    updateRouteHint()
    input.focus()
  })
  sampleButtons.appendChild(btn)
}

// Init.
if (footerBuild && typeof __COMMIT_HASH__ !== 'undefined') {
  footerBuild.textContent = `Build ${__COMMIT_HASH__} · ${__BUILD_DATE__}`
}
projectContext.value = loadProjectContext()
updateRouteHint()
renderHistory()
showState('empty')
refreshEngineStatus()
