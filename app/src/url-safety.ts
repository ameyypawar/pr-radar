/**
 * Scheme allowlist for any value that ends up as an `href`. Shared by the AuthPlane consent URL
 * (github-token.ts) and GitHub-sourced PR URLs (rendered in components/pr-row.tsx) so both are
 * checked by one rule instead of two independently-maintained ones. See #66.
 *
 * Zod's `.url()` is not a substitute here: it checks well-formedness, not scheme, so it accepts
 * `javascript:alert(1)` as a valid URL. `new URL()` plus an explicit protocol check is the actual
 * guard.
 */
const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Resolves `candidate` (against `base`, if given — relative candidates only; an absolute
 * candidate's own scheme always wins) and returns its `.href` only when the result's protocol is
 * http or https. Returns `null` for anything malformed or on any other scheme — never returns the
 * raw, unvalidated candidate.
 */
export function safeHttpUrl(candidate: string, base?: string): string | null {
  try {
    const url = new URL(candidate, base);
    return ALLOWED_URL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
