# csv-reader-speed-01

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Baroosb/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Baroosb/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in for csv-reader 1.0.0. `solve.js` is a dependency-free ES module whose `run(input)` returns, for every input `{text, header}`, exactly the answer csv-reader 1.0.0 returns — `{columns, rows, errors}` with csv-reader's broken-CSV semantics and error objects (`stray_cr`, `unterminated_quote`, `quote_junk`, `short_row`, `long_row`) — while parsing several times faster than the reference. `main.ts` is the house driver, unchanged: it reads every case from `/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

How it is faster: one left-to-right pass that cuts field text out of the input with `slice` instead of building it character by character. A record whose line holds no quote and no stray CR is split natively; quoted fields are scanned with `indexOf`, and every check runs on the sliced span so no scan wanders into the rest of the document. Correctness is guarded by the practice set (all cases identical to the reference) and by fuzzing against the reference implementation on adversarial inputs. Build history and timings are in `BUILD-NOTES.md`.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=5hnf181h&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
