# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/burnfire1-ops/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/burnfire1-ops/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A faster drop-in for [marked](https://github.com/markedjs/marked) 18.1.3: `parse(markdown)` returns exactly the HTML marked renders with its default options (GFM on, breaks off, pedantic off), for less CPU. An entry for [make.fun](https://make.fun/bounty/markdown-render-speed-02)'s "Make Markdown rendering faster" bounty.

## Layout

- `parse.js` — the parser: a fork of marked 18.1.3 (MIT, credited in the file header), restructured and optimized for the hot paths. Dependency-free ES module, exports `parse(markdown)`.
- `main.ts` — the program the harness runs: reads `/input/cases.json`, renders each case alone, writes `/output/html.json`.

## What is faster, and why it is still exact

- **Plain-text inline fast path:** an inline source with no inline-markup trigger character (`` ` ``, `*`, `_`, `~`, `[`, `!`, `<`, `\`, `&`) and no `://`, `www.`, `@` or two-spaces-before-newline is a single text token — no per-character token loop, no regexes.
- **First-character dispatch:** the inline loop tries only the tokenizers that can start with the current character (backslash: escape/break, `<`: tag/autolink, `[`/`!`: link/reflink, `*`/`_`: emphasis, backtick: code span, `~`: strikethrough, space: hard break, word character: extended autolink pre-check, else plain text).
- **Cheap pre-checks before the backtracking block regexes:** setext headings, tables and HTML blocks are only attempted when a tiny necessary-condition test passes.
- **List continuation fast check:** a list line whose first non-space character cannot start a bullet, heading, fence, HTML block, blockquote or rule skips all six continuation regexes.
- **Memoized per-indent regexes:** the indent-dependent block regexes and the per-marker list-item regex are built once and reused.

No input is recognized and nothing is cached across cases: every `parse()` call computes its output from the markdown it is given, alone.

## Verification

- Kit scorer on the practice set: 720/720, `passed: 1`.
- Determinism: two runs produce byte-identical `html.json`.
- Speed: faster than the house baseline (marked itself) on the practice set; see `BUILD_REPORT_MRS02.md` for the numbers.

<sub>Entered on [make.fun](https://make.fun/?ref=ej1kkdkc&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
