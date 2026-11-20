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
import { truncateForLocal, FORCE_LOCAL_MAX_CHARS } from './truncate.js'
import { withTimeout, friendlyTriageError, isRetryableError } from './net.js'

// Re-exported so the UI can use the same truncation (demo path) without
// importing the helper module directly.
export { truncateForLocal, FORCE_LOCAL_MAX_CHARS }

export { isFirebaseConfigured }

// A hung AI call must never leave the Triage button spinning forever:
// each attempt is abandoned after AI_REQUEST_TIMEOUT_MS (the underlying
// SDK call keeps running, the UI just stops waiting). Normal calls answer
// in ~1–8 s; 60 s is generous headroom for a slow-but-real response.
const AI_REQUEST_TIMEOUT_MS = 60000
// On-device init is a readiness gate, not a download: the Prepare button
// owns the deliberate (long) download, with progress shown. If init hangs,
// fall back to the cloud instead of spinning.
const DEVICE_INIT_TIMEOUT_MS = 30000

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
    // Fully offline: fail fast with the friendly message instead of
    // burning two retries on calls that cannot succeed. (The demo path
    // above never touches the network, so it is unaffected.)
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('You appear to be offline. Check your connection and try again.')
    }
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
          // Bounded: if init hangs, fall back to the cloud below instead
          // of spinning.
          try {
            await withTimeout(
              model.initializeDeviceModel(),
              DEVICE_INIT_TIMEOUT_MS,
              'On-device model init',
            )
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
        () =>
          withTimeout(
            model.generateContent(fullReportPrompt(text, cleanContext)),
            AI_REQUEST_TIMEOUT_MS,
            'AI request',
          ),
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
      // Bounded: if init hangs, fall back to the cloud below instead of
      // spinning.
      try {
        await withTimeout(
          model.initializeDeviceModel(),
          DEVICE_INIT_TIMEOUT_MS,
          'On-device model init',
        )
        deviceModelPrepared = true
      } catch (e) {
        // On-device init failing must not block the cloud fallback.
        console.warn('[Triage] On-device model init failed, using fallback:', e)
      }
    }
    const result = await withRetry(
      () =>
        withTimeout(
          model.generateContent(quickTriagePrompt(text, cleanContext)),
          AI_REQUEST_TIMEOUT_MS,
          'AI request',
        ),
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
