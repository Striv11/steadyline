/**
 * Streaming CSV tokenizer (RFC 4180 subset).
 *
 * Input is any sync or async iterable of string chunks (e.g. a decoded
 * `file.stream()`), so a large export is never held in memory as one string.
 * Handles quoted fields, escaped quotes (""), embedded newlines, CRLF/LF/CR
 * line ends, a leading BOM, and records split across chunk boundaries.
 * Blank lines are skipped. An unterminated quote at end of input yields the
 * partial record and sets `unterminated` via the callback-free `CsvRow.broken`.
 */
export interface CsvRow {
  /** 1-based line number where the record starts. */
  line: number;
  fields: string[];
  /** True if the input ended inside a quoted field. */
  broken?: boolean;
}

export async function* parseCsv(
  chunks: Iterable<string> | AsyncIterable<string>,
  delimiter = ',',
): AsyncGenerator<CsvRow> {
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let justClosedQuote = false;
  let line = 1;
  let recordLine = 1;
  let started = false; // any content seen in the current record
  let pendingCr = false;
  let first = true;

  const endRecord = (): CsvRow | null => {
    fields.push(field);
    const row: CsvRow = { line: recordLine, fields };
    const blank = fields.length === 1 && fields[0] === '' && !started;
    fields = [];
    field = '';
    started = false;
    justClosedQuote = false;
    return blank ? null : row;
  };

  for await (let chunk of chunks as AsyncIterable<string>) {
    if (first) {
      first = false;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (pendingCr) {
        pendingCr = false;
        if (ch === '\n') continue; // second half of CRLF
      }
      if (inQuotes) {
        if (ch === '"') {
          // Peek handled via state: a following quote re-opens (escape).
          inQuotes = false;
          justClosedQuote = true;
        } else {
          if (ch === '\n') line++;
          field += ch;
        }
        continue;
      }
      if (justClosedQuote && ch === '"') {
        field += '"';
        inQuotes = true;
        justClosedQuote = false;
        continue;
      }
      if (ch === '"' && field === '' && !justClosedQuote) {
        inQuotes = true;
        started = true;
        continue;
      }
      if (ch === delimiter) {
        fields.push(field);
        field = '';
        started = true;
        justClosedQuote = false;
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r') pendingCr = true;
        const row = endRecord();
        line++;
        recordLine = line;
        if (row) yield row;
        continue;
      }
      justClosedQuote = false;
      started = true;
      field += ch;
    }
  }
  if (inQuotes) {
    fields.push(field);
    yield { line: recordLine, fields, broken: true };
    return;
  }
  if (started || field !== '' || fields.length > 0) {
    const row = endRecord();
    if (row) yield row;
  }
}
