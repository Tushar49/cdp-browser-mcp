/**
 * Locator engine (5.5 WSA). Playwright-style selector syntax on top of the
 * existing `selector` parameter EVERYWHERE it appears.
 *
 * Design constraints (momus step-0 gate):
 *  - The VALUE is untrusted input that reaches Runtime.evaluate expression
 *    templates. It is embedded ONLY via JSON.stringify — never concatenated
 *    raw. The pinned fixture set (`locators.test.ts`) asserts the escaping
 *    for adversarial inputs before any wiring consumes this module.
 *  - Matcher predicates are SINGLE-SOURCE: self-contained functions whose
 *    `.toString()` is embedded into the page-side expression (no module
 *    scope references allowed inside them — enforced by tests evaluating
 *    them in isolation).
 *  - css + text/role/attr engines pierce OPEN shadow roots; xpath is
 *    document-root only (XPath limitation — documented, not a bug).
 *
 * Engines: css (default, byte-compatible with the old document.querySelector),
 * `css=`, `//…` / `xpath=`, `text=` (unquoted = case-insensitive contains,
 * quoted = exact), `role=` (aria-lite), `label=` (aria-label + labels),
 * `placeholder=`, `testid=` (data-testid, always exact), `alt=`, `title=`.
 */

export type LocatorEngine =
  | 'css' | 'xpath' | 'text' | 'role' | 'label' | 'placeholder' | 'testid' | 'alt' | 'title';

/** Agent-facing description of the locator syntax (5.5 WSA). */
export const LOCATOR_SYNTAX_DOC =
  'Plain CSS, or a Playwright-style engine: css=, //xpath (or xpath=), text= ("quoted" = exact match), role= (aria-lite), label=, placeholder=, testid=, alt=, title=. Append " >> nth=N", " >> first" or " >> last" when multiple elements match. Open shadow roots are pierced (xpath is document-root only).';

export interface ParsedLocator {
  engine: LocatorEngine;
  value: string;
  exact: boolean;
  /** Original selector string (diagnostics). */
  raw: string;
}

const ENGINE_PREFIXES: Array<[LocatorEngine, string]> = [
  ['css', 'css='],
  ['text', 'text='],
  ['role', 'role='],
  ['label', 'label='],
  ['placeholder', 'placeholder='],
  ['testid', 'testid='],
  ['alt', 'alt='],
  ['title', 'title='],
  ['xpath', 'xpath='],
];

/** Parse a selector string into engine + value (+ exact-quoted flag). */
export function parseLocator(selector: string): ParsedLocator {
  const raw = String(selector ?? '');
  const trimmed = raw.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('(//')) {
    return { engine: 'xpath', value: raw, exact: false, raw };
  }
  for (const [engine, prefix] of ENGINE_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      let value = trimmed.slice(prefix.length);
      let exact = false;
      const quoted = /^"([\s\S]*)"$/.exec(value) ?? /^'([\s\S]*)'$/.exec(value);
      if (quoted) {
        value = quoted[1];
        exact = true;
      }
      return { engine, value, exact, raw };
    }
  }
  return { engine: 'css', value: raw, exact: false, raw };
}

// ─── Matcher predicates (SELF-CONTAINED — no outer-scope references) ───

/** Whitespace-normalized text (Playwright semantics). */
export function normalizeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** Tags whose `textContent` is source/markup, not rendered text. */
export function isNonTextTag(tagName: unknown): boolean {
  const tag = String(tagName || '').toUpperCase();
  return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE'
    || tag === 'NOSCRIPT' || tag === 'HEAD' || tag === 'TITLE'
    || tag === 'META' || tag === 'LINK';
}

/**
 * Text an element actually renders: concatenates text nodes while skipping
 * SCRIPT/STYLE/TEMPLATE/NOSCRIPT subtrees (an ancestor's `textContent`
 * otherwise includes inline script source — e.g. `body` "containing" a
 * label only because a <script> declares it). Falls back to `textContent`
 * for DOM-less fixtures.
 */
export function renderedText(el: any): string {
  if (!el) return '';
  if (!el.childNodes || typeof el.childNodes.length !== 'number') return String(el.textContent ?? '');
  const SKIP: Record<string, number> = { SCRIPT: 1, STYLE: 1, TEMPLATE: 1, NOSCRIPT: 1 };
  let out = '';
  const walk = (n: any): void => {
    const kids = n.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) out += c.nodeValue || '';
      else if (c.nodeType === 1 && !SKIP[String(c.tagName || '').toUpperCase()]) walk(c);
    }
  };
  walk(el);
  return out;
}

/** text= engine: unquoted → case-insensitive contains; quoted → exact. */
export function matchText(el: any, needle: string, exact: boolean): boolean {
  if (!el) return false;
  if (isNonTextTag(el.tagName)) return false;
  const rawAll = String(el.textContent ?? '');
  const rawNorm = rawAll.replace(/\s+/g, ' ').trim();
  if (!exact && !rawNorm.toLowerCase().includes(String(needle).toLowerCase())) return false;
  const text = renderedText(el).replace(/\s+/g, ' ').trim();
  if (exact) return text === needle;
  return text.toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * role= engine (ARIA-LITE: explicit role attr or a tag→implicit-role map;
 * no aria-hidden inheritance, no accessible-name computation beyond none —
 * documented honestly in tool descriptions).
 */
export function matchRole(el: any, role: string): boolean {
  if (!el) return false;
  const wanted = String(role).trim().toLowerCase();
  const explicit = typeof el.getAttribute === 'function' ? String(el.getAttribute('role') || '').trim().toLowerCase() : '';
  if (explicit) return explicit.split(/\s+/)[0] === wanted;
  const tag = String(el.tagName || '').toLowerCase();
  const attr = (name: string): string | null => (typeof el.getAttribute === 'function' ? el.getAttribute(name) : null);
  switch (tag) {
    case 'button': return wanted === 'button';
    case 'a': return wanted === 'link' && attr('href') != null;
    case 'select': return wanted === 'combobox' || wanted === 'listbox';
    case 'textarea': return wanted === 'textbox';
    case 'input': {
      const type = String(attr('type') || '').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return wanted === 'button';
      if (type === 'checkbox') return wanted === 'checkbox';
      if (type === 'radio') return wanted === 'radio';
      if (type === 'search') return wanted === 'searchbox';
      if (type === 'range') return wanted === 'slider';
      return wanted === 'textbox';
    }
    case 'img': return wanted === 'img' && attr('alt') != null;
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return wanted === 'heading';
    case 'option': return wanted === 'option';
    case 'ul': case 'ol': return wanted === 'list';
    case 'li': return wanted === 'listitem';
    case 'nav': return wanted === 'navigation';
    case 'main': return wanted === 'main';
    case 'dialog': return wanted === 'dialog';
    default: return false;
  }
}

/** Attribute engines: unquoted → case-insensitive contains; quoted → exact. */
export function matchAttr(el: any, attr: string, value: string, exact: boolean): boolean {
  if (!el || typeof el.getAttribute !== 'function') return false;
  const raw = el.getAttribute(attr);
  if (raw == null) return false;
  if (exact) return String(raw) === value;
  return String(raw).toLowerCase().includes(String(value).toLowerCase());
}

/** label= engine: aria-label or associated <label> text (aria-lite). */
export function matchLabel(el: any, value: string, exact: boolean): boolean {
  if (!el) return false;
  const aria = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null;
  const hit = (text: unknown): boolean => {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim();
    return exact ? t === value : t.toLowerCase().includes(String(value).toLowerCase());
  };
  if (aria != null && hit(aria)) return true;
  const labels = el.labels;
  if (labels && typeof labels.length === 'number') {
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] && hit(labels[i].textContent)) return true;
    }
  }
  return false;
}

/** All matcher predicates embedded verbatim into page-side expressions. */
const MATCHER_FNS = [normalizeText, isNonTextTag, renderedText, matchText, matchRole, matchAttr, matchLabel];

// ─── Expression builder ─────────────────────────────────────────────

/**
 * Page-side expression returning an ARRAY of matched elements (open-shadow
 * pierced except xpath). The VALUE is embedded ONLY via JSON.stringify.
 */
export function buildLocatorMatchesExpression(selector: string): string {
  const p = parseLocator(selector);
  const fns = MATCHER_FNS.map((fn) => fn.toString()).join('\n');
  const attrName =
    p.engine === 'testid' ? 'data-testid'
      : p.engine === 'placeholder' ? 'placeholder'
        : p.engine === 'alt' ? 'alt'
          : 'title';
  return `(() => {
${fns}
  const ENGINE = ${JSON.stringify(p.engine)};
  const VALUE = ${JSON.stringify(p.value)};
  const EXACT = ${JSON.stringify(p.exact)};
  const ATTR = ${JSON.stringify(attrName)};
  const ATTR_EXACT = ${p.engine === 'testid' ? 'true' : 'EXACT'};
  if (ENGINE === 'css') {
    const out = [];
    const scan = (root) => {
      if (!root || !root.querySelectorAll) return;
      try { for (const el of root.querySelectorAll(VALUE)) out.push(el); } catch (e) { /* invalid css */ }
      for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) scan(el.shadowRoot); }
    };
    scan(document);
    return out;
  }
  if (ENGINE === 'xpath') {
    const out = [];
    try {
      const snap = document.evaluate(VALUE, document, null, 7, null);
      for (let i = 0; i < snap.snapshotLength; i++) {
        const n = snap.snapshotItem(i);
        if (n && n.nodeType === 1) out.push(n);
      }
    } catch (e) { /* invalid xpath */ }
    return out;
  }
  const all = [];
  const walk = (root) => {
    if (!root || !root.querySelectorAll) return;
    for (const el of root.querySelectorAll('*')) {
      all.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const matched = all.filter((el) =>
    ENGINE === 'text' ? matchText(el, VALUE, EXACT)
      : ENGINE === 'role' ? matchRole(el, VALUE)
        : ENGINE === 'label' ? matchLabel(el, VALUE, EXACT)
          : matchAttr(el, ATTR, VALUE, ATTR_EXACT)
  );
  // Playwright semantics: text/label engines pick the SMALLEST matching
  // element — drop ancestors that also matched.
  if (ENGINE === 'text' || ENGINE === 'label') {
    return matched.filter((el) =>
      !matched.some((other) => other !== el
        && typeof el.contains === 'function' && el.contains(other)));
  }
  return matched;
})()`;
}

/** Page-side expression returning the FIRST matched element (or null). */
export function buildLocatorFirstElementExpression(selector: string): string {
  return `(${buildLocatorMatchesExpression(selector)})[0] || null`;
}

/**
 * Page-side boolean expression for wait states over a locator
 * (`attached` | `detached` | `visible` | `hidden`) — same engine dispatch.
 */
export function buildLocatorStateExpression(selector: string, state: 'attached' | 'detached' | 'visible' | 'hidden'): string {
  const matches = buildLocatorMatchesExpression(selector);
  return `(() => {
  const matches = ${matches};
  const count = matches.length;
  if (${JSON.stringify(state)} === 'attached') return count > 0;
  if (${JSON.stringify(state)} === 'detached') return count === 0;
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  if (${JSON.stringify(state)} === 'visible') return count > 0 && matches.some(visible);
  return count === 0 || !matches.some(visible);
})()`;
}

// ─── Node-side resolution ───────────────────────────────────────────

export interface LocatorMatch {
  objectId: string;
  backendNodeId?: number;
  /** Coarse identity for error messages (tag + snippet). */
  description: string;
}

interface LocatorCtx {
  sendCommand: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;
}

/**
 * Resolve a locator to element matches. Returns up to `limit` matches in
 * document order. Throws ActionableError-style plain errors for
 * zero/multiple matches at the CALLER's discretion (strict-mode rendering
 * lives with the call sites).
 */
export async function resolveLocatorMatches(
  ctx: LocatorCtx,
  sess: string,
  selector: string,
  limit = 10,
): Promise<LocatorMatch[]> {
  const evaluated = (await ctx.sendCommand('Runtime.evaluate', {
    expression: buildLocatorMatchesExpression(selector),
    returnByValue: false,
  }, sess)) as { result?: { objectId?: string } };
  const arrayObjId = evaluated?.result?.objectId;
  if (!arrayObjId) return [];

  const props = (await ctx.sendCommand('Runtime.getProperties', {
    objectId: arrayObjId,
    ownProperties: true,
  }, sess)) as { result?: Array<{ name: string; value?: { objectId?: string; description?: string } }> };

  const out: LocatorMatch[] = [];
  for (const prop of props?.result ?? []) {
    if (!/^\d+$/.test(prop.name)) continue;
    const objectId = prop.value?.objectId;
    if (!objectId) continue;
    let backendNodeId: number | undefined;
    try {
      const described = (await ctx.sendCommand('DOM.describeNode', { objectId }, sess)) as { node?: { backendNodeId?: number } };
      backendNodeId = described?.node?.backendNodeId;
      if (!backendNodeId) {
        // Some element types (e.g. inside unbacked shadow trees) fail describeNode
        backendNodeId = undefined;
      }
    } catch {
      backendNodeId = undefined;
    }
    out.push({ objectId, backendNodeId, description: prop.value?.description ?? `element ${prop.name}` });
    if (out.length >= limit) break;
  }
  return out;
}

// ─── Strict-mode resolution ─────────────────────────────────────────

export interface LocatorIndexSuffix {
  selector: string;
  index?: number;
  mode?: 'first' | 'last';
}

/** Playwright-style disambiguator suffix: `… >> nth=1`, `… >> first`, `… >> last`. */
export function splitLocatorIndexSuffix(selector: string): LocatorIndexSuffix {
  const m = /\s*>>\s*(nth=(\d+)|first|last)\s*$/.exec(selector);
  if (!m) return { selector };
  const base = selector.slice(0, m.index).trim();
  if (m[2] !== undefined) return { selector: base, index: Number(m[2]) };
  return { selector: base, mode: m[1] as 'first' | 'last' };
}

export interface StrictLocatorResolution {
  objectId: string;
  backendNodeId?: number;
  geometry: { x: number; y: number; w: number; h: number; tag: string; label: string };
  matchCount: number;
}

/** Error that must not be retried by the actionability ladder (ambiguity). */
function nonRetriableLocatorError(message: string): Error {
  const err = new Error(message);
  (err as Error & { nonRetriable?: boolean }).nonRetriable = true;
  return err;
}

/**
 * Resolve a locator in STRICT mode: exactly one match (after applying any
 * `>> nth/first/last` suffix), or throw an actionable error naming the
 * match count and disambiguation options. Used by uid-less action paths.
 */
export async function resolveLocatorStrict(
  ctx: LocatorCtx,
  sess: string,
  selector: string,
): Promise<StrictLocatorResolution> {
  const suffix = splitLocatorIndexSuffix(selector);
  const limit = suffix.index !== undefined ? Math.max(suffix.index + 1, 100) : 100;
  const matches = await resolveLocatorMatches(ctx, sess, suffix.selector, limit);
  if (matches.length === 0) {
    throw new Error(
      `No element matched "${selector}". Verify the locator (engines: css/.\u2026, //xpath, text=, role=, label=, placeholder=, testid=, alt=, title=) or take a fresh page snapshot and use a uid.`,
    );
  }
  let picked: LocatorMatch | undefined;
  if (suffix.index !== undefined) picked = matches[suffix.index];
  else if (suffix.mode === 'first') picked = matches[0];
  else if (suffix.mode === 'last') picked = matches[matches.length - 1];
  else if (matches.length === 1) picked = matches[0];

  if (!picked) {
    if (suffix.index !== undefined) {
      throw nonRetriableLocatorError(
        `Locator "${selector}" index ${suffix.index} is out of range (only ${matches.length} match${matches.length === 1 ? '' : 'es'}).`,
      );
    }
    const preview = matches.slice(0, 3).map((m, i) => `[${i}] ${m.description.slice(0, 80)}`).join('; ');
    throw nonRetriableLocatorError(
      `Locator "${selector}" matched ${matches.length} elements (strict mode). Pick one: append " >> nth=N", " >> first" or " >> last" — or pass a uid from the page snapshot. First matches: ${preview}`,
    );
  }

  const geometry = await locatorMatchGeometry(ctx, sess, picked.objectId);
  if (!geometry) throw new Error(`Element matched "${selector}" but its geometry could not be read (detached?). Retry or use a fresh snapshot uid.`);
  return { objectId: picked.objectId, backendNodeId: picked.backendNodeId, geometry, matchCount: matches.length };
}

/** Geometry + label for one resolved match (mirrors the uid path shape). */
export async function locatorMatchGeometry(
  ctx: LocatorCtx,
  sess: string,
  objectId: string,
): Promise<{ x: number; y: number; w: number; h: number; tag: string; label: string } | null> {
  const info = (await ctx.sendCommand('Runtime.callFunctionOn', {
    functionDeclaration: `function() {
      const r = this.getBoundingClientRect();
      let fx = 0, fy = 0, w = window;
      try {
        while (w.frameElement) {
          const fr = w.frameElement.getBoundingClientRect();
          fx += fr.left; fy += fr.top;
          w = w.parent;
        }
      } catch (e) { /* cross-origin boundary */ }
      return {
        x: r.x + r.width / 2 + fx, y: r.y + r.height / 2 + fy,
        w: r.width, h: r.height,
        tag: this.tagName.toLowerCase(),
        label: (this.getAttribute('aria-label') || this.textContent || '').trim().substring(0, 60),
      };
    }`,
    objectId,
    returnByValue: true,
  }, sess)) as { result?: { value?: { x: number; y: number; w: number; h: number; tag: string; label: string } | null } };
  return info?.result?.value ?? null;
}
