/**
 * 5.5 WSA step-0 gate (momus R1/R2): pinned locator fixtures.
 *
 * Two halves:
 *  A. Matcher predicates + parser — direct, DOM-less (fixture objects).
 *  B. Expression pins — the VALUE reaches Runtime.evaluate ONLY via
 *     JSON.stringify; adversarial inputs must not break out of the
 *     expression or set globals. Every engine's expression is evaluated
 *     against a stub DOM for behavior.
 */
import { describe, it, expect } from 'vitest';
import {
  parseLocator,
  matchText,
  matchRole,
  matchAttr,
  matchLabel,
  normalizeText,
  buildLocatorMatchesExpression,
  buildLocatorStateExpression,
  resolveLocatorMatches,
  resolveLocatorStrict,
  splitLocatorIndexSuffix,
} from '../../utils/locators.js';

// ─── fixture element (plain object, DOM-less) ───────────────────────

function el(tagName: string, attrs: Record<string, string | null> = {}, text = '', extra: Record<string, unknown> = {}) {
  const lowered: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(attrs)) lowered[k.toLowerCase()] = v;
  return {
    tagName: tagName.toUpperCase(),
    textContent: text,
    getAttribute: (name: string) => (name.toLowerCase() in lowered ? lowered[name.toLowerCase()] : null),
    hasAttribute: (name: string) => name.toLowerCase() in lowered,
    ...extra,
  };
}

// ─── A. parser ──────────────────────────────────────────────────────

describe('parseLocator', () => {
  it('dispatches every explicit engine prefix', () => {
    expect(parseLocator('css=.a > b').engine).toBe('css');
    expect(parseLocator('.a > b').engine).toBe('css'); // default, byte-compatible
    expect(parseLocator('xpath=//button').engine).toBe('xpath');
    expect(parseLocator('//button').engine).toBe('xpath');
    expect(parseLocator('text=Sign in').engine).toBe('text');
    expect(parseLocator('role=button').engine).toBe('role');
    expect(parseLocator('label=Email').engine).toBe('label');
    expect(parseLocator('placeholder=you@x.com').engine).toBe('placeholder');
    expect(parseLocator('testid=submit-btn').engine).toBe('testid');
    expect(parseLocator('alt=Logo').engine).toBe('alt');
    expect(parseLocator('title=Tooltip').engine).toBe('title');
  });

  it('quoted values flip exact=true and strip the quotes (both quote styles)', () => {
    expect(parseLocator('text="Sign in"')).toMatchObject({ engine: 'text', value: 'Sign in', exact: true });
    expect(parseLocator("text='Sign in'")).toMatchObject({ engine: 'text', value: 'Sign in', exact: true });
    expect(parseLocator('label="Email"')).toMatchObject({ engine: 'label', value: 'Email', exact: true });
  });

  it('does not strip later-prefixed words inside the value', () => {
    expect(parseLocator('text=role=admin')).toMatchObject({ engine: 'text', value: 'role=admin', exact: false });
  });
});

// ─── A. matchers ────────────────────────────────────────────────────

describe('matcher predicates (single-source, DOM-less)', () => {
  it('normalizeText collapses whitespace', () => {
    expect(normalizeText(' a\n\t b   c ')).toBe('a b c');
  });

  it('matchText: unquoted = case-insensitive contains over normalized text', () => {
    expect(matchText(el('button', {}, '  Sign\n  In  '), 'sign in', false)).toBe(true);
    expect(matchText(el('button', {}, 'Sign in'), 'SIGN', false)).toBe(true);
    expect(matchText(el('button', {}, 'Sign in'), 'Sign up', false)).toBe(false);
  });

  it('matchText: exact = case-sensitive equality', () => {
    expect(matchText(el('button', {}, ' Sign  in '), 'Sign in', true)).toBe(true);
    expect(matchText(el('button', {}, 'Sign in'), 'sign in', true)).toBe(false);
  });

  it('matchText: ignores <script>/<style>/<template> source text', () => {
    expect(matchText(el('script', {}, "var label = 'Shadow Button';"), 'Shadow Button', false)).toBe(false);
    expect(matchText(el('style', {}, '.a::after { content: "Go"; }'), 'Go', false)).toBe(false);
    expect(matchText(el('template', {}, 'Go'), 'Go', false)).toBe(false);
    expect(matchText(el('button', {}, 'Shadow Button'), 'Shadow Button', false)).toBe(true);
  });

  it('matchText: an ancestor does not match text that only lives in a <script> child', () => {
    const scriptNode = { nodeType: 1, tagName: 'SCRIPT', childNodes: [{ nodeType: 3, nodeValue: 'Shadow Button' }] };
    const textNode = { nodeType: 3, nodeValue: ' Hello ' };
    const bodyLike = { tagName: 'BODY', textContent: ' Hello Shadow Button ', childNodes: [textNode, scriptNode] };
    expect(matchText(bodyLike, 'Shadow Button', false)).toBe(false);
    expect(matchText(bodyLike, 'Hello', false)).toBe(true);
  });

  it('matchRole: explicit role attribute wins', () => {
    expect(matchRole(el('div', { role: 'button' }), 'button')).toBe(true);
    expect(matchRole(el('div', { role: 'checkbox switch' }), 'checkbox')).toBe(true);
    expect(matchRole(el('div', { role: 'button' }), 'link')).toBe(false);
  });

  it('matchRole: implicit mapping (button, a[href], inputs, headings)', () => {
    expect(matchRole(el('button'), 'button')).toBe(true);
    expect(matchRole(el('a', { href: '/x' }), 'link')).toBe(true);
    expect(matchRole(el('a'), 'link')).toBe(false); // no href
    expect(matchRole(el('input', { type: 'checkbox' }), 'checkbox')).toBe(true);
    expect(matchRole(el('input', { type: 'radio' }), 'radio')).toBe(true);
    expect(matchRole(el('input', { type: 'submit' }), 'button')).toBe(true);
    expect(matchRole(el('input'), 'textbox')).toBe(true);
    expect(matchRole(el('h2'), 'heading')).toBe(true);
    expect(matchRole(el('img', { alt: 'x' }), 'img')).toBe(true);
    expect(matchRole(el('select'), 'combobox')).toBe(true);
  });

  it('matchAttr: contains by default, exact when quoted', () => {
    expect(matchAttr(el('input', { placeholder: 'Your Email Address' }), 'placeholder', 'email', false)).toBe(true);
    expect(matchAttr(el('input', { placeholder: 'Your Email Address' }), 'placeholder', 'email', true)).toBe(false);
    expect(matchAttr(el('input', { placeholder: 'Your Email Address' }), 'placeholder', 'Your Email Address', true)).toBe(true);
    expect(matchAttr(el('input'), 'placeholder', 'x', false)).toBe(false);
  });

  it('matchLabel: aria-label and associated <label> text', () => {
    expect(matchLabel(el('input', { 'aria-label': 'Email address' }), 'email', false)).toBe(true);
    const withLabels = el('input', {}, '', { labels: [{ textContent: 'Work Email' }] });
    expect(matchLabel(withLabels, 'work email', false)).toBe(true);
    expect(matchLabel(el('input'), 'email', false)).toBe(false);
  });
});

// ─── B. expression pins — the injection gate ────────────────────────

const ADVERSARIAL_VALUES = [
  '"); globalThis.__PWNED = 1; ("',
  "'); globalThis.__PWNED = 1; ('",
  '\\"); globalThis.__PWNED = 1; //',
  'line1\nline2\r\nline3',
  '</script><script>globalThis.__PWNED=1</script>',
  '${globalThis.__PWNED=1}',
  '`backtick ${x} template`',
];

describe('expression pins — untrusted VALUE never breaks out', () => {
  it('every engine embeds the value only as its JSON.stringify form', () => {
    for (const value of ADVERSARIAL_VALUES) {
      for (const engine of ['css', 'text', 'role', 'label', 'placeholder', 'testid', 'alt', 'title'] as const) {
        const selector = engine === 'css' ? `css=${value}` : `${engine}=${value}`;
        const expr = buildLocatorMatchesExpression(selector);
        const parsed = parseLocator(selector);
        expect(expr).toContain(`const VALUE = ${JSON.stringify(parsed.value)};`);
      }
    }
  });

  it('xpath engine pins the raw `//` form through JSON.stringify', () => {
    const value = '//img["onerror"]/parent::*';
    const expr = buildLocatorMatchesExpression(value);
    expect(expr).toContain(`const VALUE = ${JSON.stringify(value)};`);
  });

  it('no raw breakout sequence survives outside a JSON string literal', () => {
    for (const value of ADVERSARIAL_VALUES) {
      const expr = buildLocatorMatchesExpression(`text=${value}`);
      // strip every JSON string literal; nothing outside them may contain the payload
      const stripped = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      expect(stripped).not.toContain('__PWNED');
    }
  });

  it('evaluated with a stub DOM, an adversarial text= locator returns matches and sets no global', () => {
    const payload = '${globalThis.__PWNED=1}'; // not quote-wrapped — exercises raw embedding
    const expr = buildLocatorMatchesExpression(`text=${payload}`);
    const target = { textContent: `hello ${payload} world`, shadowRoot: null };
    const stub = {
      querySelectorAll: (sel: string) => (sel === '*' ? [target] : []),
      evaluate: () => ({ snapshotLength: 0, snapshotItem: () => null }),
    };
    const fn = new Function('document', `return ${expr};`) as (d: unknown) => unknown[];
    const result = fn(stub);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect((globalThis as Record<string, unknown>).__PWNED).toBeUndefined();
  });

  it('css engine scans top level + open shadow roots', () => {
    const inner = { id: 'shadow-child', shadowRoot: null };
    const host = { id: 'host', shadowRoot: { querySelectorAll: (s: string) => (s === '*' ? [inner] : s === '.in-shadow' ? [inner] : []) } };
    const outer = { id: 'outer', shadowRoot: null };
    const stub = {
      querySelectorAll: (s: string) => {
        if (s === '*') return [host, outer];
        if (s === '.top') return [outer];
        return [];
      },
      evaluate: () => ({ snapshotLength: 0, snapshotItem: () => null }),
    };
    const fn = new Function('document', `return ${buildLocatorMatchesExpression('.top')};`) as (d: unknown) => any[];
    expect(fn(stub).map((e) => e.id)).toEqual(['outer']);

    const shadowFn = new Function('document', `return ${buildLocatorMatchesExpression('.in-shadow')};`) as (d: unknown) => any[];
    expect(shadowFn(stub).map((e) => e.id)).toEqual(['shadow-child']);
  });
});

describe('buildLocatorStateExpression', () => {
  it('attached/detached are count-based over the engine result', () => {
    const stub = { querySelectorAll: (s: string) => (s === '*' ? [el('button', {}, 'Go')] : []), evaluate: () => ({ snapshotLength: 0, snapshotItem: () => null }) };
    const attached = new Function('document', 'getComputedStyle', `return ${buildLocatorStateExpression('text=Go', 'attached')};`);
    const detached = new Function('document', 'getComputedStyle', `return ${buildLocatorStateExpression('text=Nope', 'detached')};`);
    expect(attached(stub, () => ({}))).toBe(true);
    expect(detached(stub, () => ({}))).toBe(true);
  });
});

// ─── C. node-side resolution (mocked CDP) ───────────────────────────

describe('resolveLocatorMatches (mocked sendCommand)', () => {
  it('walks the evaluate → getProperties → describeNode chain', async () => {
    const calls: string[] = [];
    const ctx = {
      sendCommand: async (method: string) => {
        calls.push(method);
        if (method === 'Runtime.evaluate') return { result: { objectId: 'arr-1' } };
        if (method === 'Runtime.getProperties') {
          return {
            result: [
              { name: '0', value: { objectId: 'el-0', description: 'button' } },
              { name: '1', value: { objectId: 'el-1', description: 'button' } },
              { name: 'length', value: { description: '2' } },
            ],
          };
        }
        if (method === 'DOM.describeNode') return { node: { backendNodeId: 4242 } };
        return {};
      },
    };
    const matches = await resolveLocatorMatches(ctx, 's1', 'text=Go', 10);
    expect(calls).toEqual(['Runtime.evaluate', 'Runtime.getProperties', 'DOM.describeNode', 'DOM.describeNode']);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({ objectId: 'el-0', backendNodeId: 4242 });
  });

  it('limit truncates the property walk', async () => {
    const ctx = {
      sendCommand: async (method: string) => {
        if (method === 'Runtime.evaluate') return { result: { objectId: 'arr' } };
        if (method === 'Runtime.getProperties') {
          return { result: [0, 1, 2, 3].map((i) => ({ name: String(i), value: { objectId: `e${i}` } })) };
        }
        return { node: { backendNodeId: 1 } };
      },
    };
    expect(await resolveLocatorMatches(ctx, 's', '.x', 2)).toHaveLength(2);
  });
});

// ─── D. strict mode + index suffix ──────────────────────────────────

function strictCtx(matchCount: number) {
  return {
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'arr' } };
      if (method === 'Runtime.getProperties') {
        return { result: Array.from({ length: matchCount }, (_, i) => ({ name: String(i), value: { objectId: `e${i}`, description: `button ${i}` } })) };
      }
      if (method === 'DOM.describeNode') return { node: { backendNodeId: 1 } };
      if (method === 'Runtime.callFunctionOn') {
        const objectId = params?.objectId as string;
        return { result: { value: { x: 1, y: 2, w: 3, h: 4, tag: 'button', label: objectId } } };
      }
      return {};
    },
  };
}

describe('splitLocatorIndexSuffix', () => {
  it('parses nth / first / last suffixes and leaves plain selectors alone', () => {
    expect(splitLocatorIndexSuffix('text=Go')).toEqual({ selector: 'text=Go' });
    expect(splitLocatorIndexSuffix('text=Go >> nth=2')).toEqual({ selector: 'text=Go', index: 2 });
    expect(splitLocatorIndexSuffix('role=button >> first')).toEqual({ selector: 'role=button', mode: 'first' });
    expect(splitLocatorIndexSuffix('css=.x >> last')).toEqual({ selector: 'css=.x', mode: 'last' });
    expect(splitLocatorIndexSuffix('a >> b >> nth=1')).toEqual({ selector: 'a >> b', index: 1 });
  });
});

describe('resolveLocatorStrict', () => {
  it('succeeds on a single match and returns geometry', async () => {
    const r = await resolveLocatorStrict(strictCtx(1), 's', 'text=Go');
    expect(r).toMatchObject({ objectId: 'e0', matchCount: 1 });
    expect(r.geometry).toMatchObject({ x: 1, y: 2, tag: 'button' });
  });

  it('throws an actionable ambiguity error listing disambiguators', async () => {
    await expect(resolveLocatorStrict(strictCtx(3), 's', 'text=Go')).rejects.toThrow(/matched 3 elements \(strict mode\)/);
    await expect(resolveLocatorStrict(strictCtx(3), 's', 'text=Go')).rejects.toThrow(/>> nth=N/);
  });

  it('throws a not-found error naming the engines', async () => {
    await expect(resolveLocatorStrict(strictCtx(0), 's', 'text=Go')).rejects.toThrow(/No element matched/);
  });

  it('honors nth / first / last and rejects out-of-range indexes', async () => {
    await expect(resolveLocatorStrict(strictCtx(3), 's', 'text=Go >> nth=1')).resolves.toMatchObject({ objectId: 'e1' });
    await expect(resolveLocatorStrict(strictCtx(3), 's', 'text=Go >> first')).resolves.toMatchObject({ objectId: 'e0' });
    await expect(resolveLocatorStrict(strictCtx(3), 's', 'text=Go >> last')).resolves.toMatchObject({ objectId: 'e2' });
    await expect(resolveLocatorStrict(strictCtx(3), 's', 'text=Go >> nth=9')).rejects.toThrow(/out of range/);
  });
});
