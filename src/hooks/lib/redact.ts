/**
 * Secret redaction for orientation telemetry.
 *
 * Two-layer defense in depth:
 *   1. redact(obj)    — walks every string in the event object (recursively,
 *                       any depth) before serialization.
 *   2. redactLine(s)  — a second pass over the final serialized JSONL line, so a
 *                       field added later without updating the walker still gets
 *                       scrubbed on the way to disk.
 *
 * Both layers share the same pattern set (`redactString`). Patterns favour
 * precision over recall on prose: the env-assignment rule only redacts a value
 * that looks secret-shaped, so ordinary words after a sensitive-looking key
 * (e.g. "AUTHOR=Miguel") are left intact, while real secrets (length or digits)
 * are removed.
 */

type Replacer = string | ((substring: string, ...args: string[]) => string);

interface Pattern {
  re: RegExp;
  replace: Replacer;
}

/**
 * Heuristic: is this assignment value secret-shaped rather than a prose word?
 * Secrets tend to be long or contain digits; prose words after a key:value in
 * normal text ("secret: the feature") are short and alphabetic.
 */
function isSecretyValue(raw: string): boolean {
  const v = raw.replace(/^["']|["']$/g, '');
  if (v.length >= 8) return true;
  if (/\d/.test(v)) return true;
  return false;
}

const PATTERNS: Pattern[] = [
  // PEM private/certificate blocks (multiline).
  {
    re: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
    replace: '[REDACTED_PEM]',
  },
  // JWT: header.payload(.signature). eyJ is base64url of '{"'.
  {
    re: /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){1,2}/g,
    replace: '[REDACTED_JWT]',
  },
  // Standalone JWT header (no dots) — still a base64url JSON header.
  {
    re: /\beyJ[A-Za-z0-9_-]{20,}={0,2}/g,
    replace: '[REDACTED_JWT]',
  },
  // AWS access key id.
  {
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: '[REDACTED_AWS_KEY]',
  },
  // GitHub tokens: ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained github_pat_.
  {
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replace: '[REDACTED_TOKEN]',
  },
  {
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replace: '[REDACTED_TOKEN]',
  },
  // Stripe-style keys: sk_live_, sk_test_, pk_live_, rk_live_, ...
  {
    re: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,
    replace: '[REDACTED_KEY]',
  },
  // OpenAI-style sk- / sk-proj- keys. \b guards against mid-word "sk-" (e.g. task-).
  {
    re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{6,}/g,
    replace: '[REDACTED_KEY]',
  },
  // Generic sensitive env assignment: keep the key name, redact a secret-shaped
  // value. Callback so prose ("SECRET: the plan") is not over-redacted.
  {
    re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|APIKEY|AUTH|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s",}]+)/gi,
    replace: (_m: string, key: string, sep: string, val: string): string =>
      isSecretyValue(val) ? `${key}${sep}[REDACTED]` : _m,
  },
];

/** Apply every denylist pattern to a single string. */
export function redactString(input: string): string {
  let out = input;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace as string);
  }
  return out;
}

/** Recursively redact every string in a value, at any depth. Returns a new value. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') {
    return redactString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactValue(v);
    }
    return out as unknown as T;
  }
  return value;
}

/** Layer 1: deep-redact an object before serialization. */
export function redact<T>(obj: T): T {
  return redactValue(obj);
}

/** Layer 2: defense-in-depth pass over the final serialized line. */
export function redactLine(line: string): string {
  return redactString(line);
}
