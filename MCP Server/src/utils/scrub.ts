/**
 * Secrets scrubber applied at the registry.dispatch choke point (5.3 WS1 O2).
 *
 * Runs on EVERY tool result (ok()/fail()/success()/raw literals all pass
 * through dispatch) unless the result opts out via `_noScrub`. Values whose
 * KEY looks secret-bearing are masked in both structured payloads and the
 * text form.
 *
 * Over-reach is accepted and documented (plan risk row): a key like
 * "keyword" matches the `key` fragment — masking is security-biased.
 * `storage.export_state` is exempt (its whole job is exporting auth state)
 * via the `_noScrub` marker its handler sets.
 */

/** Result-key marker that opts a result out of scrubbing. */
export const NO_SCRUB = '_noScrub';

/**
 * Key fragment matcher for secret-bearing keys. Matched case-insensitively
 * against object keys and JSON/headers text, allowing suffixes
 * (accessToken, apiKey, credentialId, …).
 */
const SECRET_KEY = /(password|passwd|secret|token|authorization|auth|key|credential)/i;

/** JSON-style pair: "secretKey": "value" → value masked. */
const JSON_PAIR = /("[^"]*"\s*:\s*")([^"\\]*)(")/g;
/** Authorization-style headers: mask the ENTIRE line value (Bearer x.y.z etc.). */
const AUTH_HEADER = /((?:authorization|proxy-authorization)\s*:\s*)([^\r\n]+)/gi;
/** Plain pair: Authorization: Bearer xyz / apiKey=abc / token: abc. */
const PLAIN_PAIR = /([A-Za-z_][A-Za-z0-9_-]*)(\s*[:=]\s*)([^\s"',;&}\]]+)/g;

const MASK = '***';

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Scrub a single text string (JSON dump, header dump, plain key=value text). */
export function scrubText(text: string): string {
  let out = text.replace(AUTH_HEADER, (_, prefix: string) => `${prefix}${MASK}`);
  out = out.replace(JSON_PAIR, (whole, quotedKey: string, value: string, tail: string) => {
    const key = quotedKey.slice(1, -1);
    return isSecretKey(key) ? `${quotedKey}${MASK}${tail}` : whole;
  });
  out = out.replace(PLAIN_PAIR, (whole, key: string, sep: string) => {
    return isSecretKey(key) ? `${key}${sep}${MASK}` : whole;
  });
  return out;
}

/**
 * Scrub a ToolResult: every text content item and every string value inside
 * structured extras. No-op when `_noScrub` is set; the marker is consumed.
 */
export function scrubToolResult<T extends { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; [key: string]: unknown }>(
  result: T,
): T {
  const anyResult = result as { [key: string]: unknown };
  const exempt = anyResult[NO_SCRUB] === true;
  delete anyResult[NO_SCRUB];
  if (exempt) return result;

  if (Array.isArray(anyResult.content)) {
    for (const item of anyResult.content) {
      if (typeof item?.text === 'string' && item.text) {
        item.text = scrubText(item.text);
      }
    }
  }
  for (const [key, value] of Object.entries(anyResult)) {
    if (key === 'content') continue;
    if (typeof value === 'string' && isSecretKey(key)) {
      anyResult[key] = MASK;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      scrubObject(value as Record<string, unknown>);
    }
  }
  return result;
}

/** Recursively mask string values under secret-bearing keys in plain objects. */
function scrubObject(obj: Record<string, unknown>, depth = 0): void {
  if (depth > 6) return;
  for (const [key, value] of Object.entries(obj)) {
    if (isSecretKey(key)) {
      if (typeof value === 'string') {
        obj[key] = MASK;
      } else if (value && typeof value === 'object') {
        obj[key] = MASK;
      }
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      scrubObject(value as Record<string, unknown>, depth + 1);
    }
  }
}
