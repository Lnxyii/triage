# Triage — Bug-report triage, on-device first

**Live demo:** https://triage-hackathon-2ae3f.web.app

Triage turns a pasted bug report into a structured, severity-ranked triage in
one click — with [Firebase AI Logic](https://firebase.google.com/docs/ai-logic)
hybrid inference: **Gemini Nano on-device** when available, **Gemini in the
cloud** otherwise. Built for the **#BuildHybridAI 2026** hackathon
([Devpost](https://firebasehybridaihackathon.devpost.com/)).

## What it does

- Paste a bug report or support message, or pick a built-in sample (10
  included, 5 of them adversarial traps).
- **Short reports** get a fast triage: severity (Critical / High / Medium /
  Low), a one-sentence summary, reproduction steps, a draft reply, and a
  confidence score.
- **Long threads** (over 1,200 characters) get a full structured report:
  title, summary, severity with a **CVSS 3.1 score and vector** where the
  bug is a security issue, reproduction steps, a PoC outline, impact, and
  a recommendation. Short reports that look like security issues are
  routed to the full report too.
- **Every result names its engine** — a visible badge (**On-device ·
  Gemini Nano**, **Cloud · Gemini Flash**, or **Demo mode · local
  rules**) plus latency, so you always know where your report was
  processed.
- **Sensitive details are redacted locally before any AI call.** Email
  addresses, session tokens, API keys, passwords and similar values in a
  pasted report are replaced by typed placeholders (`[email]`,
  `[session token]`, `[api key]` …) on the device — before the text
  reaches Gemini on-device or in the cloud. History stores the scrubbed
  text, so a secret never reaches localStorage. A toggle turns scrubbing
  off; every result states what was redacted.
- **Duplicate check.** A new report is compared with your triage history
  (this browser only); if it resembles an earlier report, a "Possible
  duplicate" warning names it.
- **Project context (optional).** One short field (e.g. "Cashier web app,
  Next.js + Supabase"), saved in the browser, is included in the prompt
  so reproduction steps and recommendations fit your stack.
- **Exports that fit a developer workflow.** Copy as Markdown (paste
  straight into GitHub, Jira or Notion), Copy JSON, Download .md, Export
  CSV — and **Create GitHub Issue**, which opens a pre-filled issue on
  this repo in a new tab. No token ever enters the browser; you submit
  the issue on GitHub.
- **History** stays in the browser (localStorage) with search, a severity
  filter, per-report counts, and Export History (JSON/CSV).
- **Force Local.** An override sends even a long report to the on-device
  model (truncated to 8,000 characters) for full privacy. If Nano is
  unavailable on the device, the app falls back to the cloud and says
  so — it never pretends a cloud call was local.
- **Small things that make it a tool, not a demo:** Ctrl+Enter (Cmd+Enter)
  runs a triage; the 1,200-character route meter turns from green
  (on-device) to blue (cloud) as the report grows; the Engines and
  How-hybrid sections collapse so the page stays a work surface.

## Hybrid inference, concretely

- One model, `InferenceMode.PREFER_ON_DEVICE`: the Firebase AI Logic SDK
  tries Gemini Nano first (Chrome Prompt API) and falls back to
  `gemini-3.5-flash-lite` in the cloud. The full report uses the same plain
  cloud model (`gemini-3.5-flash-lite`).
- Structured output on both paths: the on-device side constrains the
  response with a JSON schema (`responseConstraint`), the cloud side with
  `responseSchema` + `responseMimeType: application/json`. Prompts and
  schemas live in one module (`src/prompts.js`) so both paths can never
  drift apart.
- The engine badge reads `response.inferenceSource` (`on_device` /
  `in_cloud`) from the SDK — it is never guessed.
- `initializeDeviceModel()` is called on the Triage button click (a user
  gesture, as required) and from the "Prepare on-device model" button.
- On-device inference needs Chrome on Desktop 139+ with the Gemini Nano
  model downloaded. On any other machine the app degrades gracefully to
  the cloud and says so on screen. Mobile and other browsers get the
  standard cloud experience.

## Adversarial traps

Five of the ten built-in samples are designed to fool a triage tool that
judges tone, volume, or embedded instructions instead of substance: a
prompt injection ordering the AI to mark a slow login Critical; a calm
note hiding a real session-token breach; an all-caps alarm about a version
number; a PoC that does not reproduce; a bug in a third-party component.
All five were judged correctly on the merits against the live cloud model
on 19 Nov 2026 — including the prompt-injection trap, also verified on
the deployed demo.

## Demo mode

Without a Firebase config the app runs in **demo mode**: the same flow
on deterministic local rules, every result labelled "Demo mode · local
rules (no AI)". No report text leaves the device in demo mode. Demo mode
exists to test the flow end-to-end before a Firebase project is
connected; it is not the submitted experience.

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build into dist/
npm run preview  # serve the build on http://localhost:4173
```

## Setup (live AI)

1. Create a Firebase project at console.firebase.google.com. No billing
   is needed — the Gemini Developer API path is free within limits.
2. In the console, go to **AI Services → AI Logic → Get started** and
   choose the **Gemini Developer API** provider (not Vertex AI, which
   needs billing).
3. Register a web app (**Project settings → Your apps → Web**) and copy
   the config into `triage-app/.env` (create it from `.env.example`).
   Never commit `.env`.
4. App Check: register the **reCAPTCHA Enterprise (Fraud Defense)**
   provider for the web app and put its site key in `.env` as
   `VITE_RECAPTCHA_SITE_KEY`. (reCAPTCHA v3 Classic is deprecated —
   Google blocks new v3 onboardings.) For local development keep
   `VITE_APPCHECK_DEBUG=true` and register the debug token printed in
   the browser console under **App Check → Apps → Manage debug tokens**.
5. To use the on-device path: Chrome Desktop 139+, enable on-device AI,
   and let the model download — the app's "Prepare on-device model"
   button does this with a progress indicator.

## Hosting

A static Vite single-page app, ready for Firebase Hosting.
`firebase.json` serves `dist/` with an SPA rewrite, long-lived immutable
caching for the content-hashed assets, and `no-cache` for `index.html`.

```bash
npm install -g firebase-tools   # one-time
firebase login                  # one-time, needs the project owner's Google account
npm run build
firebase deploy --only hosting
```

Live since 19 Nov 2026: https://triage-hackathon-2ae3f.web.app

## Tech stack

- **Firebase AI Logic** (`@firebase/ai` via the Firebase JS SDK) —
  Gemini Nano on-device + `gemini-3.5-flash-lite` in the cloud; App
  Check (reCAPTCHA Enterprise / debug token)
- **Vite 6** + vanilla JavaScript (ES modules), no framework
- **Firebase Hosting**
- **localStorage** for triage history (client-side only)

## Project layout

```
triage-app/
  index.html            Page shell
  src/
    main.js             UI wiring
    ai.js               Hybrid service + demo-mode engine
    prompts.js          Prompts and JSON schemas (single source of truth)
    firebase-config.js  Env-based Firebase config
    samples.js          Built-in sample reports (incl. 5 adversarial traps)
    scrub.js            Deterministic local redaction of sensitive values
    duplicate.js        Local duplicate check against history
    export.js           Markdown / CSV export of results and history
    history.js          localStorage history
    style.css           Design
  public/fonts/         Self-hosted fonts (Chakra Petch, IBM Plex Sans/Mono)
  .env.example          Config template (no secrets)
```

## License

Apache License 2.0 — see `LICENSE`.
