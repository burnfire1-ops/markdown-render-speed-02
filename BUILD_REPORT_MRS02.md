# Build report — markdown-render-speed-02

## What this is

A faster drop-in for marked 18.1.3: `parse.js` exports `parse(markdown)`, which
returns exactly the HTML `marked.parse` returns with its default options (GFM
on, breaks off, pedantic off), for less CPU. `main.ts` is the harness program:
it reads `/input/cases.json`, renders each case alone, writes `/output/html.json`.

## Design

A fork of marked 18.1.3 (MIT, licence + notice kept in the `parse.js` header),
restructured around the hot paths. Everything marked does is still done; the
work is only skipped or reordered where the result is provably identical:

- **Plain-text inline fast path:** an inline source with no inline-markup
  trigger character (`` ` ``, `*`, `_`, `~`, `[`, `!`, `<`, `\`, `&`) and no
  `://`, `www.`, `@` or two-spaces-before-newline is a single text token —
  no per-character token loop, no regexes.
- **First-character dispatch:** the inline loop tries only the tokenizers that
  can start with the current character (backslash: escape / hard break,
  `<`: tag / autolink, `[` / `!`: link / reflink, `*` / `_`: emphasis,
  backtick: code span, `~`: strikethrough, space: hard break, word character:
  extended-autolink pre-check, else plain text).
- **Cheap pre-checks before the backtracking block regexes:** setext headings,
  tables and HTML blocks are only attempted when a tiny necessary-condition
  test passes.
- **List continuation fast check:** a list line whose first non-space
  character cannot start a bullet, heading, fence, HTML block, blockquote or
  rule skips all six continuation regexes.
- **Memoized per-indent regexes:** the indent-dependent block regexes and the
  per-marker list-item regex are built once and reused.

No input is recognized and nothing is cached across cases: every `parse()`
call computes its output from the markdown it is given, alone. No network,
no install, no WASM / native / prebuilt code, no dependencies.

## Verification (practice set, kit scorer, 16 Nov 2026)

- **Correctness:** `{"passed":1,"cases_passed":720,"cases_total":720}` — all
  720 cases (680 CommonMark 0.31.2 + GFM 0.29 spec examples, 40 generated
  READMEs) byte-identical to marked 18.1.3. Zero failing check groups.
- **Determinism:** two `main.ts` runs produce byte-identical `html.json`,
  sha256 `e7e89c4fba2c45b1c4aa96c46c987e46c75a9fcdd08916b58ae7f2a7d7851724`
  — the same hash as the house baseline driver's output.
- **Speed** (alternating runs, same machine, load average ~3.8 during the
  measurement, so treat the medians as noisy):
  - parse-only, 9 alternating runs each: mine median **615.3 ms** (runs 574–
    1099 ms), marked median **713.4 ms** (685–1072 ms) — **1.16x faster**.
  - `main.ts` wall, 3 alternating runs each: mine median **1347 ms**
    (1254 / 1347 / 1433), marked median **1541 ms** (1432 / 1541 / 2060) —
    **1.14x faster**.

## Files

| file | bytes |
| --- | --- |
| `parse.js` | 68,936 |
| `main.ts` | 965 |
| `README.md` | 3,079 |
| `LICENSE` | 1,204 |
| `package.json` | 17 |
| `BUILD_REPORT_MRS02.md` | (this file) |

Repo total is far under the 1,048,576 B limit.
