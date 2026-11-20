// Head + tail truncation for Force Local (on-device) processing.
// Pure — no Firebase imports — so it is unit-testable in plain Node
// (see hidden_files/truncate-unit-test.mjs).
//
// The on-device model has a much smaller context window than the cloud
// model, so a long report is cut to FORCE_LOCAL_MAX_CHARS first. The cut
// keeps the BEGINNING and the END: a stack trace or error log at the very
// bottom of a report is usually the most important part, and a head-only
// cut would lose it. The middle is replaced by an explicit marker stating
// how many characters were omitted, so the model — and the user, via the
// UI note — can see the text is incomplete. The total is always
// <= FORCE_LOCAL_MAX_CHARS, marker included.

export const FORCE_LOCAL_MAX_CHARS = 8000
const HEAD_CHARS = 5000

export function truncateForLocal(text) {
  const s = String(text ?? '')
  if (s.length <= FORCE_LOCAL_MAX_CHARS) {
    return { text: s, truncated: false, originalLength: s.length }
  }
  const makeMarker = (n) =>
    `\n\n[...middle of report truncated — ${n.toLocaleString()} characters omitted, beginning and end kept...]\n\n`
  // The marker states how many characters the middle cut removed. That
  // count depends on the tail length, which depends on the marker length
  // — iterate until both agree (converges in at most two passes: the
  // count only moves when its digit length changes).
  let tailLen = 2900
  let marker = makeMarker(s.length - HEAD_CHARS - tailLen)
  for (let i = 0; i < 3; i++) {
    const nextTailLen = Math.max(
      0,
      FORCE_LOCAL_MAX_CHARS - HEAD_CHARS - marker.length,
    )
    const nextMarker = makeMarker(s.length - HEAD_CHARS - nextTailLen)
    tailLen = nextTailLen
    if (nextMarker.length === marker.length) {
      marker = nextMarker
      break
    }
    marker = nextMarker
  }
  const removed = s.length - HEAD_CHARS - tailLen
  let tail = tailLen > 0 ? s.slice(-tailLen) : ''
  let out = s.slice(0, HEAD_CHARS) + marker + tail
  // Final guard: if the marker grew on the last pass, trim the tail from
  // its start (never the end — the stack trace lives there) so the total
  // never exceeds the cap.
  if (out.length > FORCE_LOCAL_MAX_CHARS) {
    const excess = out.length - FORCE_LOCAL_MAX_CHARS
    tail = tail.slice(excess)
    out = s.slice(0, HEAD_CHARS) + marker + tail
  }
  return {
    text: out,
    truncated: true,
    originalLength: s.length,
  }
}
