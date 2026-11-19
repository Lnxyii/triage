// Local PII scrubber.
//
// Deterministic, pattern-based redaction of secret VALUES before any
// report text reaches an AI call (on-device or cloud) or is stored in
// history. Only values are replaced, with typed placeholders — the
// report's structure stays intact, so the triage signal is unchanged:
// "session token in the URL, sent to a third-party analytics service"
// still reads as a session-token leak after the token value itself is
// replaced by [session token].
//
// Scope is deliberately narrow: emails, URLs carrying auth/session
// parameters, known key formats (Google, GitHub, Slack, AWS, sk-,
// Bearer, JWT, PEM private keys) and `key: value` / `key=value`
// assignments whose value looks like a secret (>= 8 chars, or contains
// a digit). Things NOT scrubbed: version numbers, order numbers,
// hashes/checksums, the words "email" or "password" with no value
// attached, and "password is …" prose (no `:`/`=` separator).
// A bare value shorter than 8 characters with no digit is left alone —
// e.g. "token: the" is prose, not a secret.
//
// Pure functions, no DOM: unit-tested in hidden_files/scrub-unit-test.mjs.

const URL_PARAM_LABELS = {
  session: 'session token',
  token: 'token',
  access_token: 'token',
  auth: 'token',
  api_key: 'API key',
  apikey: 'API key',
  secret: 'secret',
  password: 'password',
  code: 'code',
  signature: 'signature',
}

const ASSIGN_LABELS = {
  password: 'password',
  passwd: 'password',
  pwd: 'password',
  api_key: 'API key',
  apikey: 'API key',
  secret: 'secret',
  access_token: 'token',
  auth_token: 'token',
  session: 'session token',
  token: 'token',
}

// A value counts as secret-looking when it is long enough or carries a
// digit. Guards the assignment rule against prose like "token: the".
function looksSecret(value) {
  return value.length >= 8 || /\d/.test(value)
}

export function scrubReport(text) {
  let out = String(text ?? '')
  const counts = new Map()
  const count = (type) => counts.set(type, (counts.get(type) || 0) + 1)

  // 1. PEM private key blocks (multi-line).
  out = out.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    () => {
      count('private key')
      return '[private key]'
    },
  )
  // 2. JWTs.
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, () => {
    count('JWT')
    return '[JWT]'
  })
  // 3. Email addresses.
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => {
    count('email')
    return '[email]'
  })
  // 4. Google API keys.
  out = out.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, () => {
    count('Google API key')
    return '[Google API key]'
  })
  // 5. GitHub tokens (classic + fine-grained).
  out = out.replace(
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    () => {
      count('GitHub token')
      return '[GitHub token]'
    },
  )
  // 6. Slack tokens.
  out = out.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, () => {
    count('Slack token')
    return '[Slack token]'
  })
  // 7. AWS access key IDs.
  out = out.replace(/\bAKIA[0-9A-Z]{16}\b/g, () => {
    count('AWS key')
    return '[AWS key]'
  })
  // 8. sk- style API keys.
  out = out.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, () => {
    count('API key')
    return '[API key]'
  })
  // 9. Bearer tokens.
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+={0,2}/gi, () => {
    count('Bearer token')
    return 'Bearer [token]'
  })
  // 10. Sensitive values in URL query strings: keep the URL, redact the value.
  out = out.replace(
    /([?&](session|token|access_token|auth|api_key|apikey|secret|password|code|signature)=)([^&\s"'<>]+)/gi,
    (m, prefix, name) => {
      const label = URL_PARAM_LABELS[name.toLowerCase()] || 'token'
      count(label)
      return `${prefix}[${label}]`
    },
  )
  // 11. Bare `key: value` / `key=value` assignments. Values already
  // replaced by rule 10 start with '[' — never redact those again.
  out = out.replace(
    /\b(password|passwd|pwd|api_key|apikey|secret|access_token|auth_token|session|token)(\s*[:=]\s*)([^\s,;'"<>]+)/gi,
    (m, name, sep, value) => {
      if (value.startsWith('[') || !looksSecret(value)) return m
      const label = ASSIGN_LABELS[name.toLowerCase()] || 'token'
      count(label)
      return `${name}${sep}[${label}]`
    },
  )

  const redactions = [...counts.entries()]
    .map(([type, n]) => ({ type, count: n }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  return {
    text: out,
    redactions,
    total: redactions.reduce((n, r) => n + r.count, 0),
  }
}

// "1 email, 2 session tokens" — for the preview and result lines.
export function describeRedactions(redactions) {
  return (redactions || [])
    .map(({ type, count }) => `${count} ${type}${count > 1 ? 's' : ''}`)
    .join(', ')
}
