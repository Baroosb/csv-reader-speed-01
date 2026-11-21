// A fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV
// reader). run(input) returns, for every input {text, header}, exactly the
// {columns, rows, errors} that csv-reader 1.0.0's readCsv returns, including
// its broken-CSV semantics:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled ("" inside it is one quote; each CRLF or lone CR inside it is
//     read as LF); what follows the closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk when the field ends);
//     a quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the remaining records (all of them when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on (every LF, CRLF and lone CR inside quotes counted), row its
//     record's index in rows (null for the header), in the order met.
//
// v3 strategy: one left-to-right pass in a single function. Unquoted fields
// scan with charCodeAt (measured faster than indexOf jumps or a byte path:
// V8's sliced strings make slice/split nearly free, while decoding bytes
// copies every field). Quoted spans are located with indexOf, and the CR
// probe inside scanQuoted runs on the sliced span only — an unbounded
// indexOf('\r') walks to the next CR in the whole file, kilobytes past the
// field, for every quoted field of an LF file, and that was v2's biggest
// single cost. Spans holding doubled quotes or CRs are rebuilt segment by
// segment; clean spans are one slice.

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  let recordLine = 1;
  let recordRow = null;
  // Shared scan results (avoid per-field allocation).
  let fVal = '', fEnded = 2, fAdded = 0;

  function scanUnquoted(prefix) {
    let seg = pos;
    let parts = null;
    let added = 0;
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        fVal = parts === null ? prefix + text.slice(seg, i) : (parts.push(text.slice(seg, i)), parts.join(''));
        fAdded = added + (i - seg); fEnded = 0; pos = i + 1; return;
      }
      if (c === 10) {
        fVal = parts === null ? prefix + text.slice(seg, i) : (parts.push(text.slice(seg, i)), parts.join(''));
        fAdded = added + (i - seg); fEnded = 1; pos = i + 1; line += 1; return;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          fVal = parts === null ? prefix + text.slice(seg, i) : (parts.push(text.slice(seg, i)), parts.join(''));
          fAdded = added + (i - seg); fEnded = 1; pos = i + 2; line += 1; return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [prefix];
        parts.push(text.slice(seg, i));
        added += i - seg;
        i += 1; seg = i; pos = i;
        continue;
      }
      i += 1;
    }
    fVal = parts === null ? prefix + text.slice(seg, n) : (parts.push(text.slice(seg, n)), parts.join(''));
    fAdded = added + (n - seg); fEnded = 2; pos = n;
  }

  function scanQuoted() {
    const open = pos;
    const openLine = line;
    let i = pos + 1;
    let close = -1;
    let hasDouble = false;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) { hasDouble = true; i = q + 2; continue; }
      close = q; break;
    }
    if (close === -1) {
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      line = openLine;
      scanUnquoted('"');
      return;
    }
    let value;
    // Bounded CR probe: slice the span (lazy in V8) and search only it —
    // an unbounded indexOf('\r') walks to the next CR in the whole file,
    // kilobytes past the field, for every quoted field of an LF file.
    const raw = text.slice(open + 1, close);
    const hasCR = raw.indexOf('\r') !== -1;
    if (!hasDouble && !hasCR) {
      value = raw;
      let lf = text.indexOf('\n', open + 1);
      while (lf !== -1 && lf < close) { line += 1; lf = text.indexOf('\n', lf + 1); }
    } else {
      const parts = [];
      let seg = open + 1;
      let j = open + 1;
      while (j < close) {
        const c = text.charCodeAt(j);
        if (c === 34) { parts.push(text.slice(seg, j), '"'); j += 2; seg = j; }
        else if (c === 13) {
          parts.push(text.slice(seg, j), '\n');
          line += 1;
          j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
          seg = j;
        } else { if (c === 10) line += 1; j += 1; }
      }
      parts.push(text.slice(seg, close));
      value = parts.join('');
    }
    pos = close + 1;
    if (pos >= n) { fVal = value; fEnded = 2; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fVal = value; fEnded = 0; return; }
    if (c === 10) { pos += 1; line += 1; fVal = value; fEnded = 1; return; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; fVal = value; fEnded = 1; return; }
    scanUnquoted(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  for (;;) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) scanQuoted(); else scanUnquoted('');
      fields.push(fVal);
    } while (fEnded === 0);

    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
