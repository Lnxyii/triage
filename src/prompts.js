// Prompts and JSON schemas for the two triage paths.
// Shared by the live Firebase path (src/ai.js) and the prompt-validation
// harness, so the prompts are tested exactly as shipped.

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low']

export const QUICK_TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    severity: {
      type: 'string',
      enum: SEVERITIES,
      description: 'Severity of the reported issue.',
    },
    summary: {
      type: 'string',
      description: 'One-sentence summary of the issue.',
    },
    reproSteps: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Short imperative reproduction steps, in order. Empty array if none can be inferred.',
    },
    draftReply: {
      type: 'string',
      description:
        'A short, polite reply to the reporter, at most 3 sentences.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the severity call, 0 to 1.',
    },
  },
  required: ['severity', 'summary', 'reproSteps', 'draftReply', 'confidence'],
}

export const FULL_REPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'Short bug title, format: [Component] does [unexpected behavior].',
    },
    summary: { type: 'string', description: 'Two-sentence summary of the issue.' },
    severity: {
      type: 'string',
      enum: SEVERITIES,
      description: 'Severity of the reported issue.',
    },
    cvssScore: {
      type: 'number',
      description: 'CVSS 3.1 base score, 0.0 to 10.0, one decimal. 0.0 if not a security issue.',
    },
    cvssVector: {
      type: 'string',
      description:
        'CVSS 3.1 vector string, e.g. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H. Use "n/a" if not a security issue.',
    },
    confidence: {
      type: 'number',
      description: 'Confidence in the severity call, 0 to 1.',
    },
    reproSteps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Numbered reproduction steps, each one short imperative sentence.',
    },
    pocOutline: {
      type: 'string',
      description:
        'How a tester can demonstrate the issue in a few lines. "n/a" if it cannot be demonstrated.',
    },
    impact: {
      type: 'string',
      description: 'Who is affected and what breaks for them.',
    },
    recommendation: {
      type: 'string',
      description: 'Concrete next step for the engineering team.',
    },
  },
  required: [
    'title',
    'summary',
    'severity',
    'cvssScore',
    'cvssVector',
    'confidence',
    'reproSteps',
    'pocOutline',
    'impact',
    'recommendation',
  ],
}

export function quickTriagePrompt(report, context = '') {
  const lines = [
    'You are a bug-triage assistant for a small software team.',
    'Read the bug report below and return ONLY a JSON object with exactly these keys, no other keys:',
    '{ "severity": "Critical" | "High" | "Medium" | "Low",',
    '  "summary": "one-sentence summary of the issue",',
    '  "reproSteps": ["short imperative step", "..."],',
    '  "draftReply": "a short, polite reply to the reporter, at most 3 sentences",',
    '  "confidence": 0.0 to 1.0 }',
    'Use an empty array for reproSteps if no steps can be inferred.',
    'Sensitive values were redacted locally before this prompt and appear as bracketed placeholders like [email] or [session token] — treat a placeholder as the thing it names, not as literal text.',
  ]
  if (String(context || '').trim()) {
    lines.push(
      `Project context: ${String(context).trim()}`,
      'Use this project context when writing reproduction steps and the draft reply — name the actual components, frameworks, and flows of this project instead of generic steps.',
    )
  }
  lines.push(
    'Severity guide:',
    '- Critical: data loss, security breach, or the app is unusable for all users.',
    '- High: a major feature is broken, payments are affected, or the workaround is painful.',
    '- Medium: a feature is degraded but a workaround exists.',
    '- Low: cosmetic issue, typo, or minor inconvenience.',
    'Bug report:',
    '"""',
    report,
    '"""',
  )
  return lines.join('\n')
}

export function fullReportPrompt(report, context = '') {
  const lines = [
    'You are a senior QA engineer writing a structured bug report.',
    'Read the bug report or support thread below and return ONLY a JSON object with exactly these keys, no other keys:',
    '{ "title": "[Component] does [unexpected behavior]",',
    '  "summary": "two-sentence summary of the issue",',
    '  "severity": "Critical" | "High" | "Medium" | "Low",',
    '  "cvssScore": 0.0 to 10.0 with one decimal,',
    '  "cvssVector": "CVSS 3.1 vector string, or \\"n/a\\" if not a security issue",',
    '  "confidence": 0.0 to 1.0,',
    '  "reproSteps": ["short imperative step", "..."],',
    '  "pocOutline": "how a tester can demonstrate the issue, or \\"n/a\\"",',
    '  "impact": "who is affected and what breaks for them",',
    '  "recommendation": "concrete next step for the engineering team" }',
    'Severity guide:',
    '- Critical: data loss, security breach, or the app is unusable for all users.',
    '- High: a major feature is broken, payments are affected, or the workaround is painful.',
    '- Medium: a feature is degraded but a workaround exists.',
    '- Low: cosmetic issue, typo, or minor inconvenience.',
    'If the issue is a security issue, score it with CVSS 3.1 and give the vector string.',
    'If it is not a security issue, set cvssScore to 0.0 and cvssVector to "n/a".',
    'Sensitive values were redacted locally before this prompt and appear as bracketed placeholders like [email] or [session token] — treat a placeholder as the thing it names, not as literal text.',
    'Keep every field concise: 1-3 sentences each, at most 8 repro steps.',
  ]
  if (String(context || '').trim()) {
    lines.push(
      `Project context: ${String(context).trim()}`,
      'Use this project context when writing reproduction steps and the recommendation — name the actual components, frameworks, and flows of this project instead of generic steps.',
    )
  }
  lines.push(
    'Bug report / thread:',
    '"""',
    report,
    '"""',
  )
  return lines.join('\n')
}

// Route: short reports get the fast on-device triage; long threads get the
// full cloud report. 1200 characters is the split point — and a short report
// that looks like a security issue is routed to the full report too, so it
// still gets a CVSS score, a PoC outline, and a recommendation.
// The keyword set is deliberately narrow: "password" / "log in" are NOT
// keywords, because the Login-crash sample ("type my email and password")
// must stay on the quick path.
export const LONG_REPORT_CHARS = 1200

const SECURITY_KEYWORDS =
  /\b(auth|tokens?|sessions?|payments?|breaches?|xss|sql)\b|data\s+loss|\bleaks?\b/i

export function routeReason(report) {
  const text = report.trim()
  if (text.length > LONG_REPORT_CHARS) return { kind: 'full', reason: 'length' }
  if (SECURITY_KEYWORDS.test(text)) return { kind: 'full', reason: 'security' }
  return { kind: 'quick', reason: 'quick' }
}

export function routeFor(report) {
  return routeReason(report).kind
}
