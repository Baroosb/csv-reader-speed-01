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
// Strategy: one left-to-right pass. A record whose line holds no quote and
// no stray CR is split natively; other records go through field readers that
// scan with charCodeAt and cut field text out with slice, rebuilding a field
// from segments only when a stray CR or a quoted span forces it.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

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
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null while it is the header record).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // The current field reader's results, shared to avoid allocating a
  // result object per field.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `initial`, up to the next comma or line
  // break. A CR not followed by LF is dropped (stray_cr). Sets fValue,
  // fEnded and fAdded (the number of characters kept from the text).
  function readUnquoted(initial) {
    let i = pos;
    let start = pos;
    let parts = null;
    let added = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        // ','
        if (parts === null) {
          fValue = initial + text.slice(start, i);
          fAdded = added + (i - start);
        } else {
          parts.push(text.slice(start, i));
          fValue = initial + parts.join('');
          fAdded = added + (i - start);
        }
        fEnded = COMMA;
        pos = i + 1;
        return;
      }
      if (c === 10) {
        // LF
        if (parts === null) {
          fValue = initial + text.slice(start, i);
          fAdded = added + (i - start);
        } else {
          parts.push(text.slice(start, i));
          fValue = initial + parts.join('');
          fAdded = added + (i - start);
        }
        fEnded = LINE_BREAK;
        pos = i + 1;
        line += 1;
        return;
      }
      if (c === 13) {
        // CR
        if (text.charCodeAt(i + 1) === 10) {
          if (parts === null) {
            fValue = initial + text.slice(start, i);
            fAdded = added + (i - start);
          } else {
            parts.push(text.slice(start, i));
            fValue = initial + parts.join('');
            fAdded = added + (i - start);
          }
          fEnded = LINE_BREAK;
          pos = i + 2;
          line += 1;
          return;
        }
        // A lone CR is dropped.
        if (parts === null) parts = [];
        parts.push(text.slice(start, i));
        added += i - start;
        error('stray_cr');
        i += 1;
        start = i;
        continue;
      }
      i += 1;
    }
    if (parts === null) {
      fValue = initial + text.slice(start, i);
      fAdded = added + (i - start);
    } else {
      parts.push(text.slice(start, i));
      fValue = initial + parts.join('');
      fAdded = added + (i - start);
    }
    fEnded = END;
    pos = i;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const contentStart = pos + 1;

    // Find the closing quote: the next quote that is not doubled. When
    // the first quote met already closes the field, the span holds no
    // quote at all and needs no unescaping.
    let close = -1;
    let spanQuotes = false;
    let i = contentStart;
    while (true) {
      const q = text.indexOf('"', i);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        spanQuotes = true;
        i = q + 2;
        continue;
      }
      close = q;
      break;
    }

    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      readUnquoted('"');
      return;
    }

    // Read the quoted span [contentStart, close): "" is one quote, each
    // CRLF or lone CR is one LF, and every line break inside counts a line.
    // All checks run on the sliced span, never on the text past it, so no
    // scan wanders into the rest of the document.
    let value;
    const raw = text.slice(contentStart, close);
    if (raw.indexOf('\r') === -1) {
      let j = raw.indexOf('\n');
      while (j !== -1) {
        line += 1;
        j = raw.indexOf('\n', j + 1);
      }
      value = raw.indexOf('"') === -1 ? raw : raw.split('""').join('"');
    } else {
      const out = [];
      let seg = contentStart;
      let k = contentStart;
      while (k < close) {
        const c = text.charCodeAt(k);
        if (c === 34) {
          // A doubled quote inside the span.
          out.push(text.slice(seg, k), '"');
          k += 2;
          seg = k;
          continue;
        }
        if (c === 13) {
          out.push(text.slice(seg, k), '\n');
          line += 1;
          k += text.charCodeAt(k + 1) === 10 ? 2 : 1;
          seg = k;
          continue;
        }
        if (c === 10) line += 1;
        k += 1;
      }
      out.push(text.slice(seg, close));
      value = out.join('');
    }

    pos = close + 1;
    if (pos >= n) {
      fValue = value;
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fValue = value;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fValue = value;
      fEnded = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    readUnquoted(value);
    if (fAdded > 0) error('quote_junk');
  }

  // Pads or cuts a finished record to the first record's width and stores
  // it (or takes it as the columns when it is the header record).
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's line holds no quote and no stray CR, so it
    // is one line of plain fields to split. (A trailing CR is stripped
    // only when it belongs to a CRLF; at the end of the text it is a
    // stray CR and stays in the span, which keeps this path off it.)
    const lf = text.indexOf('\n', pos);
    const spanEnd = lf === -1 ? n : lf;
    let contentEnd = spanEnd;
    if (lf !== -1 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
    if (contentEnd > pos) {
      const lineStr = text.slice(pos, contentEnd);
      if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
        const fields = lineStr.split(',');
        pos = lf === -1 ? n : lf + 1;
        if (lf !== -1) line += 1;
        finishRecord(fields);
        continue;
      }
    }

    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) readQuoted();
      else readUnquoted('');
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
