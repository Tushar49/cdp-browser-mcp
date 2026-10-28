/**
 * 5.3 WS5 — proto-wire: hand-rolled AnnotatedPageContent parser.
 * Builds synthetic protobuf payloads with a minimal encoder (mirrors the
 * wire format; field numbers from common_quality_data.proto at
 * implementation time) and asserts the labeled-tree rendering + the
 * no-harm fallback (null on ANY malformed input).
 */
import { describe, it, expect } from 'vitest';
import { decodeAnnotatedPageContent, readWireFields } from '../../utils/proto-wire.js';
import { Buffer } from 'buffer';

// ── minimal protobuf ENCODER (tests only) ──────────────────────────
function varint(v: number): Buffer {
  const bytes: number[] = [];
  let x = v;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b += 128;
    bytes.push(b);
  } while (x > 0);
  return Buffer.from(bytes);
}
function tag(num: number, wireType: number): Buffer {
  return varint((num << 3) | wireType);
}
function encBytes(num: number, data: Buffer): Buffer {
  return Buffer.concat([tag(num, 2), varint(data.length), data]);
}
const encStr = (num: number, s: string) => encBytes(num, Buffer.from(s, 'utf8'));
const encVarintField = (num: number, v: number) => Buffer.concat([tag(num, 0), varint(v)]);
/** proto3 negative int32 → 10-byte two's-complement varint */
const encNegInt32 = (num: number, v: number) => Buffer.concat([tag(num, 0), varint(v >>> 0)]);

// ContentAttributes helpers
const attrs = (o: {
  type?: number; text?: string; label?: string; anchorUrl?: string;
  imageUrl?: string; imageCaption?: string; formName?: string; formAction?: string;
  controlType?: number; fieldName?: string; fieldValue?: string; placeholder?: string;
  required?: boolean; checked?: boolean; tableName?: string; geom?: { x: number; y: number; w: number; h: number };
  selectOptions?: Array<{ value?: string; text?: string }>;
  iframeUrl?: string; iframeTitle?: string; iframeRedacted?: number;
}) => {
  const parts: Buffer[] = [];
  if (o.type !== undefined) parts.push(encVarintField(3, o.type));
  if (o.geom) {
    const rect = Buffer.concat([
      encNegInt32(1, o.geom.x), encNegInt32(2, o.geom.y),
      encVarintField(3, o.geom.w), encVarintField(4, o.geom.h),
    ]);
    parts.push(encBytes(4, encBytes(2, rect))); // geometry(4).visible(2)
  }
  if (o.text !== undefined) parts.push(encBytes(10, encStr(1, o.text)));
  if (o.label !== undefined) parts.push(encStr(16, o.label));
  if (o.anchorUrl !== undefined) parts.push(encBytes(14, encStr(1, o.anchorUrl)));
  if (o.imageUrl !== undefined || o.imageCaption !== undefined) {
    const img: Buffer[] = [];
    if (o.imageCaption !== undefined) img.push(encStr(2, o.imageCaption));
    if (o.imageUrl !== undefined) img.push(encStr(5, o.imageUrl));
    parts.push(encBytes(11, Buffer.concat(img)));
  }
  if (o.formName !== undefined || o.formAction !== undefined) {
    const f: Buffer[] = [];
    if (o.formName !== undefined) f.push(encStr(1, o.formName));
    if (o.formAction !== undefined) f.push(encStr(2, o.formAction));
    parts.push(encBytes(19, Buffer.concat(f)));
  }
  if (o.controlType !== undefined || o.fieldName !== undefined || o.fieldValue !== undefined || o.selectOptions) {
    const c: Buffer[] = [];
    if (o.fieldName !== undefined) c.push(encStr(1, o.fieldName));
    if (o.fieldValue !== undefined) c.push(encStr(2, o.fieldValue));
    if (o.controlType !== undefined) c.push(encVarintField(3, o.controlType));
    for (const opt of o.selectOptions ?? []) {
      const ob: Buffer[] = [];
      if (opt.value !== undefined) ob.push(encStr(1, opt.value));
      if (opt.text !== undefined) ob.push(encStr(2, opt.text));
      c.push(encBytes(4, Buffer.concat(ob)));
    }
    if (o.placeholder !== undefined) c.push(encStr(5, o.placeholder));
    if (o.required) c.push(encVarintField(7, 1));
    if (o.checked) c.push(encVarintField(6, 1));
    parts.push(encBytes(20, Buffer.concat(c)));
  }
  if (o.tableName !== undefined) parts.push(encBytes(8, encStr(1, o.tableName)));
  if (o.iframeUrl !== undefined || o.iframeTitle !== undefined) {
    const f: Buffer[] = [];
    if (o.iframeUrl !== undefined) f.push(encStr(4, o.iframeUrl));
    if (o.iframeTitle !== undefined) f.push(encStr(5, o.iframeTitle));
    parts.push(encBytes(9, encBytes(3, Buffer.concat(f))));
  }
  if (o.iframeRedacted !== undefined) {
    parts.push(encBytes(9, encBytes(4, encVarintField(1, o.iframeRedacted))));
  }
  return Buffer.concat(parts);
};

/** ContentNode: children(1, repeated) + content_attributes(2) */
const node = (children: Buffer[], attrsBuf?: Buffer): Buffer => {
  const parts = children.map((c) => encBytes(1, c));
  if (attrsBuf) parts.push(encBytes(2, attrsBuf));
  return Buffer.concat(parts);
};

/** AnnotatedPageContent top level */
const apc = (o: { root?: Buffer; url?: string; title?: string; mode?: number; tabId?: number }) => {
  const parts: Buffer[] = [];
  if (o.root) parts.push(encBytes(2, o.root));
  if (o.url !== undefined || o.title !== undefined) {
    const f: Buffer[] = [];
    if (o.url !== undefined) f.push(encStr(4, o.url));
    if (o.title !== undefined) f.push(encStr(5, o.title));
    parts.push(encBytes(3, Buffer.concat(f)));
  }
  if (o.mode !== undefined) parts.push(encVarintField(6, o.mode));
  if (o.tabId !== undefined) parts.push(encVarintField(7, o.tabId));
  return parts.length ? Buffer.concat(parts) : Buffer.from([0x08, 0x00]); // just field 1 varint 0
};

const decode = (buf: Buffer) => decodeAnnotatedPageContent(buf.toString('base64'));

describe('proto-wire readWireFields (layer 1)', () => {
  it('reads varint, fixed32, length-delimited fields', () => {
    const buf = Buffer.concat([
      encVarintField(1, 300),
      Buffer.concat([tag(2, 5), Buffer.from([1, 2, 3, 4])]),
      encStr(3, 'hello'),
    ]);
    const fields = readWireFields(buf);
    expect(fields).toHaveLength(3);
    expect(fields[0]).toMatchObject({ num: 1, value: 300 });
    expect(fields[1]).toMatchObject({ num: 2, value: 0x04030201 });
    expect(fields[2].bytes?.toString()).toBe('hello');
  });

  it('throws on truncated varint / unknown wire types', () => {
    expect(() => readWireFields(Buffer.from([0x08]))).toThrow();
    expect(() => readWireFields(Buffer.from([0x0b]))).toThrow(); // group start (3)
  });
});

describe('decodeAnnotatedPageContent (layers 2+3)', () => {
  it('renders heading, text, link with geometry, and meta header', () => {
    const root = node([
      node([], attrs({ type: 5, text: 'Pricing plans' })),
      node([], attrs({ type: 20, text: 'Our plans start at $9.' })),
      node([], attrs({ type: 22, text: 'Sign up', anchorUrl: 'https://example.com/signup', geom: { x: 10, y: 20, w: 80, h: 30 } })),
    ], attrs({ type: 1 }));
    const r = decode(apc({ root, url: 'https://example.com/', title: 'Example', mode: 1, tabId: 42 }));
    expect(r).not.toBeNull();
    expect(r!.lines[0]).toContain('[APC]');
    expect(r!.lines[0]).toContain('mode=actionable-elements');
    expect(r!.lines[0]).toContain('tab=42');
    expect(r!.lines[0]).toContain('url=https://example.com/');
    expect(r!.lines[0]).toContain('title="Example"');
    const text = r!.lines.join('\n');
    expect(text).toContain('# Pricing plans');
    expect(text).toContain('Our plans start at $9.');
    expect(text).toContain('link: Sign up → https://example.com/signup');
    expect(text).toContain('@10,20 80×30');
    expect(r!.nodeCount).toBe(4);
  });

  it('renders forms with controls, options, placeholder, flags', () => {
    const form = node([
      node([], attrs({ type: 24, controlType: 3, fieldName: 'email', placeholder: 'you@example.com', required: true })),
      node([], attrs({ type: 24, controlType: 12, fieldName: 'plan', selectOptions: [{ value: 'free', text: 'Free tier' }] })),
    ], attrs({ type: 8, formName: 'newsletter', formAction: 'https://example.com/subscribe' }));
    const r = decode(apc({ root: node([form], attrs({ type: 1 })) }));
    expect(r).not.toBeNull();
    const text = r!.lines.join('\n');
    expect(text).toContain('form "newsletter" action=https://example.com/subscribe');
    expect(text).toContain('input[email] name="email" placeholder="you@example.com" required');
    expect(text).toContain('input[select] name="plan"');
  });

  it('renders image, table, iframe (url + redacted)', () => {
    const root = node([
      node([], attrs({ type: 9, imageCaption: 'A red bicycle', imageUrl: 'https://example.com/bike.jpg' })),
      node([node([node([], attrs({ type: 11, text: 'Free' }))], attrs({ type: 21 }))], attrs({ type: 10, tableName: 'Plans' })),
      node([], attrs({ type: 3, iframeUrl: 'https://embed.example.com/x', iframeTitle: 'Embedded' })),
    ], attrs({ type: 1 }));
    const r = decode(apc({ root }));
    const text = r!.lines.join('\n');
    expect(text).toContain('img: A red bicycle src=https://example.com/bike.jpg');
    expect(text).toContain('table "Plans"');
    expect(text).toContain('Free');
    expect(text).toContain('iframe "Embedded" url=https://embed.example.com/x');
  });

  it('unknown attribute type surfaces by number, children still render', () => {
    const root = node([node([], attrs({ type: 20, text: 'inner' }))], attrs({ type: 99 }));
    const r = decode(apc({ root }));
    const text = r!.lines.join('\n');
    expect(text).toContain('[type:99]');
  });

  it('negative geometry (above viewport) renders signed', () => {
    const root = node([], attrs({ type: 20, text: 'offscreen', geom: { x: -5, y: -300, w: 40, h: 20 } }));
    const r = decode(apc({ root }));
    expect(r!.lines.join('\n')).toContain('@-5,-300 40×20');
  });

  it('select options render joined', () => {
    const withOpts = Buffer.concat([
      encStr(1, 'plan'), encVarintField(3, 12),
      encBytes(4, Buffer.concat([encStr(1, 'free'), encStr(2, 'Free tier')])),
      encBytes(4, Buffer.concat([encStr(1, 'pro'), encStr(2, 'Pro')])),
    ]);
    const root = node([node([], Buffer.concat([encVarintField(3, 24), encBytes(20, withOpts)]))], attrs({ type: 1 }));
    const r = decode(apc({ root }));
    expect(r!.lines.join('\n')).toContain('options[Free tier|Pro]');
  });

  it('malformed input returns null (no-harm fallback)', () => {
    expect(decodeAnnotatedPageContent('!!!!')).toBeNull();
    expect(decodeAnnotatedPageContent(Buffer.from([0x0b, 0x01]).toString('base64'))).toBeNull(); // group wire type
    expect(decodeAnnotatedPageContent(Buffer.from([0x08, 0x00]).toString('base64'))).toBeNull(); // no root_node
  });

  it('node cap triggers without hanging', () => {
    const siblings = Array.from({ length: 4500 }, () => node([], attrs({ type: 20, text: 'x' })));
    const r = decode(apc({ root: node(siblings, attrs({ type: 1 })) }));
    expect(r).not.toBeNull();
    expect(r!.capped).toBe(true);
    expect(r!.lines.join('\n')).toContain('node cap');
  });
});
