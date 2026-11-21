# Build notes

Entry for csv-reader-speed-01-run-20261121: a `solve.js` that answers
exactly as csv-reader 1.0.0's `readCsv` does, only faster. `main.ts` is the
house driver, copied unchanged. Everything below was measured on this
machine (shared VM, Node 24) against the kit's baseline on the kit's
practice set (6 cases, ~10.2 MB of CSV in total); timings are medians of 9
interleaved repetitions per case, parse time only.

## v1 — first correct build

Design: one left-to-right pass. Records whose line holds no quote and no
stray CR are split with `String.split`; all other records go through two
field readers (`readUnquoted`, `readQuoted`) that scan with `charCodeAt`
and cut field text out with `slice`, rebuilding a field from segments only
when a stray CR interrupts it. Quoted spans are located with `indexOf`,
`""` collapses by `split`/`join`, and an unterminated quote rewinds and
re-reads as unquoted, exactly as the reference does.

Verified: practice set exact on all 6 cases; 140,000 adversarial fuzz
cases (piece-soup and document-style generators: quotes, CR/LF/CRLF, BOM,
junk after quotes, unterminated quotes, empty lines, ragged rows) with
0 mismatches against the baseline's `readCsv`.

Timings (ms, baseline → v1): g-0001 156.82 → 31.94 · g-0002 83.05 → 35.52 ·
g-0003 78.17 → 14.76 · g-0004 75.66 → 27.31 · g-0005 72.26 → 19.70 ·
g-0006 49.64 → 20.19 · **total 515.60 → 149.42 (3.45x)**.

## v2 — bounded scans (shipped)

Profiling v1 showed two scans that could wander far past the field they
served: `readQuoted` probed for a CR with `indexOf` on the whole text
(in a case with only 241 CRs in 1.8 MB, that is kilobytes of scanning per
quoted field), and the per-record fast-path probe did the same for quotes
and CRs. v2 slices the span (or the line) first and runs every check on
the slice, so each scan is bounded by the field or line it belongs to.

Re-verified after the change: practice set exact on all 6 cases; the same
fuzz generators re-run, 0 mismatches.

Timings (ms, baseline → v2): g-0001 98.86 → 22.08 · g-0002 78.00 → 21.95 ·
g-0003 72.52 → 14.27 · g-0004 79.55 → 17.20 · g-0005 59.21 → 17.07 ·
g-0006 67.57 → 16.91 · **total 455.70 → 109.48 (4.16x)**.

## v2-era experiment — tried, not kept

Shortcut in `readQuoted`: when the first quote met already closes the
field, the span provably holds no quote, so the unescape check could be
skipped. It passed the practice set and fuzzing, but two benchmark runs
gave totals of 112.42 ms and 138.48 ms against v2's 109.48 ms and
112.31 ms — no reliable gain on this machine, so the simpler v2 ships.

## v3 — bounded CR probe in the quoted reader (this build)

Work driven by a leaderboard scout (1,348 ranked entries; the board's
cpu_us runs 40 ms at #1 to 570 ms at #10) and an outside review (Gemini):
the frontier advertises byte paths and SWAR, so both were tried and
measured on the practice set with one yardstick (full-set parse-only,
best of 9, this machine):

- baseline csv-reader: 448 ms
- v2 as shipped (line fast path): 127 ms
- v2 compact single-function variant: 90 ms
- full byte path (UTF-8 bytes, native indexOf, decode per field): 363 ms
  — decoding copies every field; V8's sliced strings are cheaper.
- indexOf-jump unquoted scan (strings): 164 ms — three native scans per
  field lose to one charCodeAt pass.
- split/join for doubled-quote spans: 90 ms — allocation beats the walk
  only on paper; measured worse.
- indexOf-jump span walk for CR spans: 93 ms — spans are short; the
  char walk wins.
- **v3 = compact variant + the CR probe in scanQuoted bounded to the
  sliced span: 82 ms (5.5x vs baseline).** In v2 the probe was
  `indexOf('\r', open + 1)` on the whole text: on an LF file (a few
  hundred CRs in 1.8M chars) every quoted field paid a scan of
  kilobytes past its own end.

Verified: practice set exact on all 6 cases; 30,000 piece-soup fuzz
cases and 30,000 document-style fuzz cases, 0 mismatches against the
baseline's readCsv.
