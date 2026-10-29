/**
 * Hand-rolled protobuf wire parser for Page.getAnnotatedPageContent (5.3 WS5).
 *
 * The CDP response carries a base64-encoded `AnnotatedPageContent` protobuf
 * (components/optimization_guide/proto/features/common_quality_data.proto).
 * This module decodes it WITHOUT a proto compiler or dependency: a generic
 * wire reader (layer 1) plus an advisory FIELD_MAP (layer 2) seeded from the
 * .proto at implementation time.
 *
 * NO-HARM GUARANTEE (plan v5.3.0 WS5): field numbers are NOT stable API —
 * the map is never load-bearing. Any parse failure, missing root node, or
 * sanity-check miss returns null and the caller falls back to the previous
 * flat output. Unknown fields are surfaced by field number, never dropped.
 */

// ─── Layer 1: generic protobuf wire reader ──────────────────────────

export interface WireField {
  num: number;
  wireType: number;
  /** wireType 0 (varint) or 5 (fixed32 → 4 bytes) or 1 (fixed64 → as number) */
  value?: number;
  /** wireType 2 (length-delimited) */
  bytes?: Buffer;
}

const MAX_VARINT_BYTES = 10;

function readVarint(buf: Buffer, pos: number, end: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    if (pos >= end) throw new Error('varint truncated');
    const b = buf[pos++];
    // Numbers here are far below 2^53 in practice; accumulate on two lanes to
    // stay exact up to 2^53 without BigInt.
    if (shift < 28) {
      result += (b & 0x7f) * 2 ** shift;
    } else if (shift < 53) {
      result += (b & 0x7f) * 2 ** shift;
    } else if ((b & 0x7f) !== 0) {
      // Beyond 2^53 — clamp (never load-bearing; sanity check will fall back).
      result = Number.MAX_SAFE_INTEGER;
    }
    if ((b & 0x80) === 0) return { value: result, next: pos };
    shift += 7;
  }
  throw new Error('varint too long');
}

/** Interpret a raw varint as a signed int32 (proto3 negatives encode as 10 bytes). */
function asInt32(v: number): number {
  return v >= 2 ** 31 ? v - 2 ** 32 : v;
}

export function readWireFields(buf: Buffer, start = 0, end = buf.length): WireField[] {
  const fields: WireField[] = [];
  let pos = start;
  while (pos < end) {
    const tag = readVarint(buf, pos, end);
    pos = tag.next;
    const num = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (num < 1) throw new Error('invalid field number');
    if (wireType === 0) {
      const v = readVarint(buf, pos, end);
      pos = v.next;
      fields.push({ num, wireType, value: v.value });
    } else if (wireType === 1) {
      if (pos + 8 > end) throw new Error('fixed64 truncated');
      fields.push({ num, wireType, value: Number(buf.readBigUInt64LE(pos)) });
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos, end);
      pos = len.next;
      if (pos + len.value > end) throw new Error('length-delimited truncated');
      fields.push({ num, wireType, bytes: buf.slice(pos, pos + len.value) });
      pos += len.value;
    } else if (wireType === 5) {
      if (pos + 4 > end) throw new Error('fixed32 truncated');
      fields.push({ num, wireType, value: buf.readUInt32LE(pos) });
      pos += 4;
    } else {
      // Wire types 3/4 (legacy groups) unsupported → parse-fail path.
      throw new Error(`unsupported wire type ${wireType}`);
    }
  }
  return fields;
}

function fieldOf(fields: WireField[], num: number): WireField | undefined {
  return fields.find((f) => f.num === num);
}

function sub(fields: WireField[], num: number): WireField[] {
  const f = fieldOf(fields, num);
  return f?.bytes ? readWireFields(f.bytes) : [];
}

function str(fields: WireField[], num: number): string | undefined {
  const f = fieldOf(fields, num);
  return f?.bytes ? f.bytes.toString('utf8') : undefined;
}

function num(fields: WireField[], num2: number, signed = false): number | undefined {
  const f = fieldOf(fields, num2);
  if (f?.value === undefined) return undefined;
  return signed ? asInt32(f.value) : f.value;
}

// ─── Layer 2: advisory FIELD_MAP (field numbers are NOT stable API) ──

const NODE_TYPES: Record<number, string> = {
  1: 'root', 2: 'container', 3: 'iframe', 4: 'paragraph', 5: 'heading',
  6: 'ordered-list', 7: 'unordered-list', 8: 'form', 9: 'image', 10: 'table',
  11: 'table-cell', 20: 'text', 21: 'table-row', 22: 'anchor', 23: 'list-item',
  24: 'form-control', 25: 'svg', 26: 'canvas', 27: 'video',
  28: 'dialog-modal', 29: 'dialog-modeless', 30: 'math',
};

const CONTROL_TYPES: Record<number, string> = {
  1: 'contenteditable', 2: 'checkbox', 3: 'email', 4: 'month', 5: 'number',
  6: 'password', 7: 'radio', 8: 'search', 9: 'tel', 10: 'text', 11: 'url',
  12: 'select', 13: 'select-multi', 15: 'textarea', 16: 'button', 17: 'submit',
  18: 'reset', 19: 'popover', 20: 'fieldset', 21: 'button', 22: 'color',
  23: 'date', 24: 'datetime-local', 25: 'file', 26: 'hidden', 27: 'image',
  28: 'range', 29: 'reset', 30: 'submit', 31: 'time', 32: 'week', 33: 'output',
};

const MODES: Record<number, string> = {
  0: 'default', 1: 'actionable-elements',
};

const MAX_NODES = 4000;
const MAX_DEPTH = 40;
const MAX_TEXT = 240;

const clamp = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);

function fmtRect(fields: WireField[], fieldNum: number): string | null {
  const r = sub(fields, fieldNum);
  const x = num(r, 1, true);
  const y = num(r, 2, true);
  const w = num(r, 3, true);
  const h = num(r, 4, true);
  if (x === undefined || y === undefined || w === undefined || h === undefined) return null;
  return `@${x},${y} ${w}×${h}`;
}

interface NodeAttrs {
  type?: number;
  domId?: number;
  label?: string;
  text?: string;
  anchorUrl?: string;
  imageUrl?: string;
  imageCaption?: string;
  formName?: string;
  formAction?: string;
  controlType?: number;
  fieldName?: string;
  fieldValue?: string;
  placeholder?: string;
  isRequired?: boolean;
  isChecked?: boolean;
  selectOptions?: Array<{ value?: string; text?: string }>;
  tableName?: string;
  iframeUrl?: string;
  iframeTitle?: string;
  iframeRedacted?: string;
  geometry?: string | null;
  unknownFields: number[];
}

function parseAttrs(fields: WireField[]): NodeAttrs {
  const a: NodeAttrs = { unknownFields: [] };
  const known = new Set([2, 3, 4, 8, 9, 10, 11, 13, 14, 15, 16, 19, 20, 21, 23, 24, 27, 28, 29, 30]);
  a.type = num(fields, 3);
  a.domId = num(fields, 2);
  a.label = str(fields, 16);
  const geom = sub(fields, 4);
  a.geometry = fmtRect(geom, 2) ?? fmtRect(geom, 1);

  const textData = sub(fields, 10);
  if (textData.length) a.text = str(textData, 1);

  const img = sub(fields, 11);
  if (img.length) {
    a.imageCaption = str(img, 2);
    a.imageUrl = str(img, 5);
  }
  const anchor = sub(fields, 14);
  if (anchor.length) a.anchorUrl = str(anchor, 1);

  const form = sub(fields, 19);
  if (form.length) {
    a.formName = str(form, 1);
    a.formAction = str(form, 2);
  }

  const control = sub(fields, 20);
  if (control.length) {
    a.controlType = num(control, 3);
    a.fieldName = str(control, 1);
    a.fieldValue = str(control, 2);
    a.placeholder = str(control, 5);
    a.isRequired = num(control, 7) === 1;
    a.isChecked = num(control, 6) === 1;
    a.selectOptions = [];
    for (const f of fields.filter((x) => x.num === 20)) {
      if (!f.bytes) continue;
      for (const opt of readWireFields(f.bytes).filter((x) => x.num === 4)) {
        if (!opt.bytes) continue;
        const o = readWireFields(opt.bytes);
        a.selectOptions.push({ value: str(o, 1), text: str(o, 2) });
      }
    }
  }

  const table = sub(fields, 8);
  if (table.length) a.tableName = str(table, 1);

  const iframe = sub(fields, 9);
  if (iframe.length) {
    const frame = sub(iframe, 3);
    if (frame.length) {
      a.iframeUrl = str(frame, 4);
      a.iframeTitle = str(frame, 5);
    } else {
      const redacted = sub(iframe, 4);
      const reason = num(redacted, 1);
      a.iframeRedacted = reason === 1 ? 'cross-site' : reason === 2 ? 'cross-origin' : `reason:${reason ?? '?'}`;
    }
  }

  for (const f of fields) {
    if (!known.has(f.num)) a.unknownFields.push(f.num);
  }
  return a;
}

function renderAttrsLine(a: NodeAttrs): string | null {
  const typeName = a.type !== undefined ? (NODE_TYPES[a.type] ?? `type:${a.type}`) : 'unknown';
  const where = a.geometry ? ` ${a.geometry}` : '';
  switch (a.type) {
    case 5: { // heading
      const t = a.text ?? a.label ?? '';
      return t ? `# ${clamp(t)}${where}` : null;
    }
    case 4: // paragraph
    case 20: { // text
      const t = a.text ?? a.label ?? '';
      return t ? `${clamp(t)}${where}` : null;
    }
    case 22: { // anchor
      const t = a.text ?? a.label ?? '';
      const url = a.anchorUrl ? ` → ${a.anchorUrl}` : '';
      return t || url ? `link: ${clamp(t)}${url}${where}` : null;
    }
    case 9: { // image
      const cap = a.imageCaption ? ` ${clamp(a.imageCaption)}` : '';
      const src = a.imageUrl ? ` src=${a.imageUrl}` : '';
      return `img:${cap}${src}${where}`;
    }
    case 8: { // form
      const n = a.formName ? ` "${a.formName}"` : '';
      const act = a.formAction ? ` action=${a.formAction}` : '';
      return `form${n}${act}${where}`;
    }
    case 24: { // form control
      const ct = a.controlType !== undefined ? (CONTROL_TYPES[a.controlType] ?? `control:${a.controlType}`) : 'control:?';
      const bits: string[] = [];
      if (a.fieldName) bits.push(`name="${a.fieldName}"`);
      if (a.fieldValue) bits.push(`value="${clamp(a.fieldValue)}"`);
      if (a.placeholder) bits.push(`placeholder="${clamp(a.placeholder)}"`);
      if (a.isChecked) bits.push('checked');
      if (a.isRequired) bits.push('required');
      if (a.selectOptions?.length) {
        bits.push(`options[${a.selectOptions.map((o) => o.text ?? o.value ?? '').join('|')}]`);
      }
      return `input[${ct}]${bits.length ? ' ' + bits.join(' ') : ''}${where}`;
    }
    case 10: { // table
      const n = a.tableName ? ` "${a.tableName}"` : '';
      return `table${n}${where}`;
    }
    case 21: // table-row
      return null; // cells render as children
    case 3: { // iframe
      if (a.iframeRedacted) return `iframe (redacted: ${a.iframeRedacted})`;
      const t = a.iframeTitle ? ` "${clamp(a.iframeTitle)}"` : '';
      return `iframe${t}${a.iframeUrl ? ` url=${a.iframeUrl}` : ''}${where}`;
    }
    case 25: case 26: case 27: case 30:
      return `${NODE_TYPES[a.type]}${where}`;
    case 28: case 29:
      return `[${NODE_TYPES[a.type]}]${where}`;
    case 1: case 2: case 6: case 7: case 23:
      return null; // structural containers — children carry the content
    case 11: { // table-cell — cells carry text
      const t = a.text ?? a.label ?? '';
      return t ? clamp(t) : null;
    }
    default:
      return `[${typeName}]${where}`; // unknown → surfaced by number
  }
}

interface WalkState {
  lines: string[];
  nodes: number;
  capped: boolean;
}

function walkNode(fields: WireField[], depth: number, state: WalkState): void {
  if (state.capped || depth > MAX_DEPTH) return;
  state.nodes++;
  if (state.nodes > MAX_NODES) {
    state.capped = true;
    return;
  }
  const attrsField = fieldOf(fields, 2);
  if (attrsField?.bytes) {
    const attrs = parseAttrs(readWireFields(attrsField.bytes));
    const line = renderAttrsLine(attrs);
    if (line) state.lines.push('  '.repeat(depth) + line);
    if (attrs.unknownFields.length && (attrs.type === undefined || NODE_TYPES[attrs.type] === undefined)) {
      state.lines.push('  '.repeat(depth) + `[unknown fields: ${[...new Set(attrs.unknownFields)].join(',')}]`);
    }
  }
  // children_nodes live on ContentNode itself (field 1, repeated)
  for (const child of fields.filter((f) => f.num === 1)) {
    if (!child.bytes) continue;
    walkNode(readWireFields(child.bytes), depth + 1, state);
  }
}

export interface AnnotatedPageContentParsed {
  mode?: string;
  tabId?: number;
  url?: string;
  title?: string;
  nodeCount: number;
  capped: boolean;
  lines: string[];
}

/**
 * Decode a base64 AnnotatedPageContent into a labeled text tree.
 * Returns null on ANY failure (caller falls back to the flat output).
 */
export function decodeAnnotatedPageContent(base64: string): AnnotatedPageContentParsed | null {
  try {
    const buf = Buffer.from(base64, 'base64');
    if (buf.length < 4) return null;
    const top = readWireFields(buf);
    const mode = num(top, 6);
    const tabId = num(top, 7, true);

    const frame = sub(top, 3);
    const url = str(frame, 4);
    const title = str(frame, 5);

    const rootField = fieldOf(top, 2);
    if (!rootField?.bytes) return null;

    const state: WalkState = { lines: [], nodes: 0, capped: false };
    walkNode(readWireFields(rootField.bytes), 0, state);
    if (state.capped) state.lines.push(`  …(node cap ${MAX_NODES} reached — output truncated)`);

    // Sanity check (auto-fallback): a tree with no content-bearing line is
    // a parse miss (proto drift), not a real page.
    const hasContent = state.lines.some((l) => l.trim().length > 0);
    if (!hasContent) return null;

    const meta: string[] = [];
    if (mode !== undefined) meta.push(`mode=${MODES[mode] ?? `mode:${mode}`}`);
    if (tabId !== undefined) meta.push(`tab=${tabId}`);
    if (url) meta.push(`url=${url}`);
    if (title) meta.push(`title="${clamp(title)}"`);
    const header = meta.length ? `[APC] ${meta.join(' ')}` : '[APC]';
    return {
      mode: mode !== undefined ? (MODES[mode] ?? `mode:${mode}`) : undefined,
      tabId, url, title,
      nodeCount: state.nodes,
      capped: state.capped,
      lines: [header, ...state.lines],
    };
  } catch {
    return null; // no-harm guarantee: caller falls back
  }
}
