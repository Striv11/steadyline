/**
 * Minimal streaming XML tokenizer (SAX style) for very large exports such as
 * Apple Health `export.xml`. It consumes string chunks, emits open/close tag
 * events and discards text content, comments, processing instructions and the
 * DOCTYPE (Apple embeds a DTD with `[ ... ]` in it). Memory use is bounded by
 * the largest single tag, not by the file. It is not a validating parser.
 */
export type XmlEvent =
  | { type: 'open'; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string };

export interface XmlState {
  /** True when the input ended inside a tag, comment or other construct. */
  truncated: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

const ATTR = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseTag(body: string): XmlEvent | null {
  if (body.startsWith('/')) {
    const name = body.slice(1).trim();
    return name ? { type: 'close', name } : null;
  }
  const selfClosing = body.endsWith('/');
  const inner = selfClosing ? body.slice(0, -1) : body;
  const m = /^[^\s/]+/.exec(inner);
  if (!m) return null;
  const attrs: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let a = ATTR.exec(inner); a; a = ATTR.exec(inner)) {
    attrs[a[1]!] = decodeEntities(a[2] ?? a[3] ?? '');
  }
  return { type: 'open', name: m[0], attrs, selfClosing };
}

/** End index (exclusive) of the construct starting at `from`, or -1 if more input is needed. */
function constructEnd(buf: string, from: number): number {
  const rest = (s: string) => buf.startsWith(s, from);
  const after = (term: string, skip: number) => {
    const i = buf.indexOf(term, from + skip);
    return i < 0 ? -1 : i + term.length;
  };
  if (rest('<!--')) return after('-->', 4);
  if (rest('<![CDATA[')) return after(']]>', 9);
  if (rest('<?')) return after('?>', 2);
  if (rest('<!')) {
    // DOCTYPE: skip to the first '>' outside any [...] subset.
    let depth = 0;
    for (let i = from + 2; i < buf.length; i++) {
      const c = buf[i];
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth <= 0) return i + 1;
    }
    return -1;
  }
  // Ordinary tag: '>' that is not inside a quoted attribute value.
  let quote = '';
  for (let i = from + 1; i < buf.length; i++) {
    const c = buf[i]!;
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
  }
  return -1;
}

export async function* parseXml(
  chunks: Iterable<string> | AsyncIterable<string>,
  state: XmlState = { truncated: false },
): AsyncGenerator<XmlEvent> {
  let buf = '';
  const drain = function* (final: boolean): Generator<XmlEvent> {
    let pos = 0;
    for (;;) {
      const lt = buf.indexOf('<', pos);
      if (lt < 0) {
        pos = buf.length;
        break;
      }
      const end = constructEnd(buf, lt);
      if (end < 0) {
        pos = lt;
        if (final) state.truncated = true;
        break;
      }
      pos = end;
      if (buf[lt + 1] === '!' || buf[lt + 1] === '?') continue;
      const ev = parseTag(buf.slice(lt + 1, end - 1).trim());
      if (ev) yield ev;
    }
    buf = buf.slice(pos);
  };
  for await (const chunk of chunks) {
    buf += chunk;
    yield* drain(false);
  }
  yield* drain(true);
}

/** Decode a byte stream (e.g. `file.stream()`) to string chunks without splitting characters. */
export async function* decodeStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      if (s) yield s;
    }
    const tail = dec.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
