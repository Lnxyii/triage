// Hybrid inference service.
// Live path: Firebase AI Logic (Gemini Nano on-device via Chrome Prompt API,
// Gemini in the cloud as fallback) — used only when Firebase is configured.
// Demo path: deterministic local rules, honestly labelled, so the full triage
// flow can be exercised end-to-end before the Firebase project exists.
//
// Engine labels are never guessed: the live path reads
// response.inferenceSource ('on_device' | 'in_cloud') from the SDK.

import { initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check'
import {
  getAI,
  getGenerativeModel,
  GoogleAIBackend,
  InferenceMode,
  Schema,
} from 'firebase/ai'
import {
  firebaseConfig,
  recaptchaSiteKey,
  appCheckDebug,
  isFirebaseConfigured,
} from './firebase-config.js'
import {
  QUICK_TRIAGE_SCHEMA,
  FULL_REPORT_SCHEMA,
  quickTriagePrompt,
  fullReportPrompt,
  routeFor,
  routeReason,
  SEVERITIES,
} from './prompts.js'
import { scrubReport } from './scrub.js'

export { isFirebaseConfigured }

const CLOUD_QUICK_MODEL = 'gemini-3.5-flash-lite'
// Full report uses the same lite model: gemini-3.8-flash (the API's named
// replacement for gemini-2.5-flash) 503'd "Deadline expired" on BOTH live
// calls in the 19 Nov Box verification, while 3.5-flash-lite answered in
// ~4 s. Free-tier capacity for 3.8-flash is unreliable right now; revisit
// only with fresh evidence that it answers.
const CLOUD_FULL_MODEL = 'gemini-3.5-flash-lite'

let app = null
let ai = null
let hybridModel = null
let fullHybridModel = null
let cloudModel = null
let deviceModelPrepared = false
let fullDeviceModelPrepared = false

// Convert a plain JSON-schema object (see src/prompts.js) into the SDK's
// Schema class instances, the documented way to set responseSchema.
function toSdkSchema(schema) {
  if (!schema || typeof schema !== 'object') return Schema.string()
  if (schema.type === 'object') {
    const properties = {}
    for (const [key, value] of Object.entries(schema.properties || {})) {
      properties[key] = toSdkSchema(value)
    }
    return Schema.object({
      properties,
      optionalProperties: Object.keys(properties).filter(
        (k) => !(schema.required || []).includes(k),
      ),
      description: schema.description,
    })
  }
  if (schema.type === 'array') {
    return Schema.array({ items: toSdkSchema(schema.items || { type: 'string' }) })
  }
  if (schema.type === 'number') return Schema.number({ description: schema.description })
  if (schema.enum) {
    return Schema.enumString({ enum: schema.enum, description: schema.description })
  }
  return Schema.string({ description: schema.description })
}

function ensureFirebase() {
  if (!isFirebaseConfigured()) return null
  if (!app) {
    app = initializeApp(firebaseConfig)
    // App Check is enforced for AI Logic. In local development the debug
    // provider is used (VITE_APPCHECK_DEBUG=true); the debug token printed
    // in the console must be registered in the Firebase console once.
    if (appCheckDebug) {
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = true
    }
    if (recaptchaSiteKey) {
      initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(recaptchaSiteKey),
        isTokenAutoRefreshEnabled: true,
      })
    } else {
      console.warn(
        '[Triage] No reCAPTCHA site key (VITE_RECAPTCHA_SITE_KEY). ' +
          'App Check is not initialised; cloud calls may be rejected. ' +
          'See firebase-setup-checklist.md.',
      )
    }
    ai = getAI(app, { backend: new GoogleAIBackend() })
  }
  return ai
}

function ensureHybridModel() {
  ensureFirebase()
  if (!ai) return null
  if (!hybridModel) {
    hybridModel = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      // On-device side: the Chrome Prompt API takes a plain JSON-schema
      // object as its response constraint.
      onDeviceParams: { promptOptions: { responseConstraint: QUICK_TRIAGE_SCHEMA } },
      // Cloud fallback: gemini-3.5-flash-lite, same schema via the SDK.
      inCloudParams: {
        model: CLOUD_QUICK_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toSdkSchema(QUICK_TRIAGE_SCHEMA),
          maxOutputTokens: 1024,
        },
      },
    })
  }
  return hybridModel
}

function ensureCloudModel() {
  ensureFirebase()
  if (!ai) return null
  if (!cloudModel) {
    cloudModel = getGenerativeModel(ai, {
      model: CLOUD_FULL_MODEL,
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toSdkSchema(FULL_REPORT_SCHEMA),
        // A complete full report is ~300-400 output tokens; 2048 leaves
        // ample headroom so the JSON is never cut off mid-string.
        maxOutputTokens: 2048,
      },
    })
  }
  return cloudModel
}

// Full-report twin of ensureHybridModel: PREFER_ON_DEVICE with the full
// schema as the on-device constraint and the same cloud model as fallback.
// Used for short reports that look like security issues — the most
// sensitive reports should stay on-device when Nano is available, not be
// pushed to the cloud by default. The SDK falls back to the cloud
// automatically when on-device is unavailable, so the engine badge always
// shows where the report really ran.
function ensureFullHybridModel() {
  ensureFirebase()
  if (!ai) return null
  if (!fullHybridModel) {
    fullHybridModel = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      onDeviceParams: { promptOptions: { responseConstraint: FULL_REPORT_SCHEMA } },
      inCloudParams: {
        model: CLOUD_FULL_MODEL,
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: toSdkSchema(FULL_REPORT_SCHEMA),
          maxOutputTokens: 2048,
        },
      },
    })
  }
  return fullHybridModel
}

// Must be called from a user gesture (button click) and before any query.
export async function prepareOnDeviceModel(onProgress) {
  const model = ensureHybridModel()
  if (!model) throw new Error('Firebase is not configured yet.')
  await model.initializeDeviceModel(onProgress)
  deviceModelPrepared = true
}

export async function getEngineStatus() {
  let nano = 'unsupported'
  try {
    if (typeof window !== 'undefined' && window.LanguageModel?.availability) {
      nano = await window.LanguageModel.availability()
    }
  } catch {
    nano = 'unavailable'
  }
  return {
    firebaseConfigured: isFirebaseConfigured(),
    nano, // available | downloading | downloadable | unavailable | unsupported
    cloudModel: CLOUD_FULL_MODEL,
    mode: 'PREFER_ON_DEVICE',
  }
}

// --- Transient-failure retry ------------------------------------------------
// 429 / 503 / 5xx / network failures are retried twice (2 s, then 5 s)
// before the error reaches the user. 400 / 401 / 403 are never retried:
// those are not transient.
function isRetryableError(err) {
  const msg = String(err?.message || err || '')
  if (/400|401|403|app check|permission-denied|unauthenticated|invalid argument/i.test(msg)) {
    return false
  }
  return /429|quota|503|overloaded|deadline expired|unavailable|500|502|504|failed to fetch|network|offline|ERR_INTERNET|ERR_NAME_NOT_RESOLVED/i.test(
    msg,
  )
}

async function withRetry(fn, onRetry) {
  const delaysMs = [2000, 5000]
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (!isRetryableError(err) || attempt >= delaysMs.length) throw err
      attempt += 1
      onRetry?.(attempt)
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt - 1]))
    }
  }
}

// --- Result parsing -------------------------------------------------------

function parseJsonResponse(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  return JSON.parse(cleaned)
}

function normaliseQuick(data) {
  const severity = SEVERITIES.includes(data.severity) ? data.severity : 'Medium'
  return {
    severity,
    summary: String(data.summary || '').trim(),
    reproSteps: Array.isArray(data.reproSteps)
      ? data.reproSteps.map((s) => String(s).trim()).filter(Boolean)
      : [],
    draftReply: String(data.draftReply || '').trim(),
    confidence:
      typeof data.confidence === 'number'
        ? Math.min(1, Math.max(0, data.confidence))
        : null,
  }
}

function normaliseFull(data) {
  const quick = normaliseQuick(data)
  return {
    ...quick,
    title: String(data.title || quick.summary || 'Untitled report').trim(),
    cvssScore:
      typeof data.cvssScore === 'number'
        ? Math.min(10, Math.max(0, data.cvssScore))
        : 0,
    cvssVector: String(data.cvssVector || 'n/a').trim(),
    pocOutline: String(data.pocOutline || 'n/a').trim(),
    impact: String(data.impact || '').trim(),
    recommendation: String(data.recommendation || '').trim(),
  }
}

// --- Demo engine (local rules, no AI) -------------------------------------
// Runs the identical flow end-to-end before Firebase exists. Every result
// from this path is labelled "Demo mode" in the UI.

const SEVERITY_RULES = [
  {
    level: 'Critical',
    re: /data loss|deleted (all|everything|my)|wiped|security|breach|exposed|leak|password.*(visible|plain)|locked out|can't log ?in|cannot log ?in|crash(es|ing)? on (launch|startup|open)/i,
  },
  {
    level: 'High',
    re: /crash|payment|charged twice|double charg|checkout|can'?t save|won'?t load|broken|blank screen|500|error 500|lost (my|all) (work|data|progress)/i,
  },
  {
    level: 'Low',
    re: /typo|misspell|color|colour|alignment|cosmetic|icon|spacing|font size/i,
  },
]

function demoSeverity(text) {
  for (const rule of SEVERITY_RULES) {
    if (rule.re.test(text)) return rule.level
  }
  return 'Medium'
}

function demoReproSteps(text) {
  const steps = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:\d+[.)]|[-*•])\s+(.+)/)
    if (m) steps.push(m[1].trim())
  }
  if (steps.length) return steps.slice(0, 6)
  // Fallback: sentences that read like actions.
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((s) => /^(i|when|then|after|click|tap|open|go|try|press)\b/i.test(s.trim()))
    .map((s) => s.trim())
    .slice(0, 4)
}

function demoQuick(text) {
  const severity = demoSeverity(text)
  const firstSentence = (text.split(/(?<=[.!?])\s+/)[0] || text).trim()
  return {
    severity,
    summary: firstSentence.length > 140 ? firstSentence.slice(0, 137) + '…' : firstSentence,
    reproSteps: demoReproSteps(text),
    draftReply:
      severity === 'Critical' || severity === 'High'
        ? 'Thanks for reporting this — we are treating it as urgent and the team is looking into it now. We will update you here as soon as we have a fix or a workaround.'
        : 'Thanks for the report. We have logged it and will look into it — we will follow up here if we need more detail.',
    confidence: null,
  }
}

const DEMO_CVSS = { Critical: 9.0, High: 7.0, Medium: 4.5, Low: 1.5 }

function demoFull(text) {
  const quick = demoQuick(text)
  return {
    ...quick,
    title: quick.summary.replace(/\.$/, ''),
    cvssScore: DEMO_CVSS[quick.severity],
    cvssVector: 'estimated — AI scoring needs Firebase',
    pocOutline: 'n/a — connect Firebase for an AI-generated PoC outline.',
    impact: `Users hitting this ${quick.severity.toLowerCase()}-severity issue. See the report for details.`,
    recommendation: 'Reproduce with the steps above, then fix and add a regression test.',
  }
}

// Exported for the UI's "Try demo mode instead" fallback button.
export function demoTriage(report, kind) {
  return kind === 'full' ? demoFull(report) : demoQuick(report)
}

// Map a raw SDK failure to a friendly message for the user. Never surface
// internal details (gateway URLs, project IDs, model names, repo files).
function friendlyTriageError(err) {
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
  if (/429|quota|503|overloaded|deadline expired|unavailable|500|502|504|internal error/i.test(msg)) {
    return 'The AI service is busy or the quota is exhausted. Try again in a moment.'
  }
  return 'The AI service could not answer right now. Try again, or use demo mode.'
}

// Force Local: when the user forces on-device processing, a long report is
// cut to this many characters first — the on-device model has a much
// smaller context window than the cloud model, so the cut keeps the call
// inside it. The cut is always disclosed in the UI (see main.js); the
// stored history keeps the truncated text, never the part that was cut.
export const FORCE_LOCAL_MAX_CHARS = 8000

export function truncateForLocal(text) {
  const s = String(text ?? '')
  if (s.length <= FORCE_LOCAL_MAX_CHARS) {
    return { text: s, truncated: false, originalLength: s.length }
  }
  return {
    text: s.slice(0, FORCE_LOCAL_MAX_CHARS),
    truncated: true,
    originalLength: s.length,
  }
}

// --- Main entry point -----------------------------------------------------
// The report is scrubbed locally first (src/scrub.js): secret values are
// replaced by typed placeholders before any AI call — on-device or cloud
// — so a secret never enters a prompt. The placeholders preserve the
// report's structure, so triage quality is unchanged. The result carries
// the scrubbed text and the redaction list, so the UI can show exactly
// what was redacted and history stores the scrubbed text only.
//
// `context` (optional project context) is appended to the prompt, so
// repro steps and recommendations name the project's real stack.
// `forceLocal` routes long reports through the PREFER_ON_DEVICE full
// model instead of the cloud-only model; the SDK still falls back to the
// cloud when on-device is unavailable, and the result badge + a warning
// line in the UI say so — local processing is never faked.

export async function triage(
  report,
  { forceFull = false, onRetry, scrub = true, context = '', forceLocal = false } = {},
) {
  const started = performance.now()
  const scrubbed = scrub
    ? scrubReport(report)
    : { text: report, redactions: [], total: 0 }
  let text = scrubbed.text
  let truncated = false
  let originalLength = text.length
  if (forceLocal) {
    const t = truncateForLocal(text)
    text = t.text
    truncated = t.truncated
    originalLength = t.originalLength
  }
  const kind = forceFull ? 'full' : routeFor(text)
  const cleanContext = String(context || '').trim()

  if (!isFirebaseConfigured()) {
    const data = kind === 'full' ? demoFull(text) : demoQuick(text)
    return {
      kind,
      data,
      report: text,
      redactions: scrubbed.redactions,
      engine: 'demo',
      model: 'local rules (no AI)',
      latencyMs: Math.round(performance.now() - started),
      context: cleanContext,
      forceLocalRequested: forceLocal,
      truncated,
      originalLength,
    }
  }

  try {
    if (kind === 'full') {
      // Security reports prefer on-device when Nano is available: they run
      // through the PREFER_ON_DEVICE full model, which falls back to the
      // cloud automatically when on-device is unavailable. Long threads
      // stay on the cloud-only model (capacity + the verified path) —
      // unless the user forced on-device processing, in which case they
      // take the same hybrid model (truncated to the on-device window).
      const reason = routeReason(text).reason
      let model
      if (reason === 'security' || forceLocal) {
        model = ensureFullHybridModel()
        if (!fullDeviceModelPrepared) {
          // initializeDeviceModel must run on a user gesture; the Triage
          // button click is one. It is a no-op when the model is ready.
          try {
            await model.initializeDeviceModel()
            fullDeviceModelPrepared = true
          } catch (e) {
            // On-device init failing must not block the cloud fallback.
            console.warn('[Triage] On-device model init failed, using fallback:', e)
          }
        }
      } else {
        model = ensureCloudModel()
      }
      const result = await withRetry(
        () => model.generateContent(fullReportPrompt(text, cleanContext)),
        onRetry,
      )
      const data = normaliseFull(parseJsonResponse(result.response.text()))
      const engine = result.response.inferenceSource || 'in_cloud'
      return {
        kind,
        data,
        report: text,
        redactions: scrubbed.redactions,
        engine,
        model:
          engine === 'on_device' ? 'Gemini Nano (on-device)' : CLOUD_FULL_MODEL,
        latencyMs: Math.round(performance.now() - started),
        context: cleanContext,
        forceLocalRequested: forceLocal,
        truncated,
        originalLength,
      }
    }

    const model = ensureHybridModel()
    if (!deviceModelPrepared) {
      // initializeDeviceModel must run on a user gesture; the Triage button
      // click is one. It is a no-op when the model is already ready.
      try {
        await model.initializeDeviceModel()
        deviceModelPrepared = true
      } catch (e) {
        // On-device init failing must not block the cloud fallback.
        console.warn('[Triage] On-device model init failed, using fallback:', e)
      }
    }
    const result = await withRetry(
      () => model.generateContent(quickTriagePrompt(text, cleanContext)),
      onRetry,
    )
    const data = normaliseQuick(parseJsonResponse(result.response.text()))
    return {
      kind,
      data,
      report: text,
      redactions: scrubbed.redactions,
      engine: result.response.inferenceSource || 'in_cloud',
      model:
        result.response.inferenceSource === 'on_device'
          ? 'Gemini Nano (on-device)'
          : CLOUD_QUICK_MODEL,
      latencyMs: Math.round(performance.now() - started),
      context: cleanContext,
      forceLocalRequested: forceLocal,
      truncated,
      originalLength,
    }
  } catch (err) {
    const error = new Error(friendlyTriageError(err))
    error.cause = err
    throw error
  }
}
