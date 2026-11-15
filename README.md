[![markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/burnfire1-ops/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/burnfire1-ops/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

# markdown-render-speed-02

A faster drop-in for [marked](https://github.com/markedjs/marked) 18.1.3.
`parse(markdown)` returns exactly the HTML marked 18.1.3 renders with its
default options (GFM on, breaks off, pedantic off, async off), for less CPU.

## How it works

A fork of marked 18.1.3, restructured and optimized for speed — all
optimizations are semantics-preserving:

- **Plain-text inline fast path.** An inline source that contains no inline
  constructs at all (no `` ` ``, `~`, `\`, `<`, `[`, `!`, `*`, `_`, `&`,
  `www.`, `://`, `mailto:`, `xmpp:`, `@`, or a hard break) skips the whole
  inline tokenizer and becomes a single text token. About 76% of inline
  sources in README-like documents take this path.
- **First-character dispatch in the inline loop.** Each inline tokenizer is
  only tried when the current character can start it, instead of running
  ~10 anchored regexes at every position. Bare-URL detection is pre-checked
  with a cheap prefix/`@` test before the URL regex runs.
- **First-character dispatch in the block loop**, plus a cheap setext
  pre-check (bounded to the first blank line) so the expensive lheading
  regex only runs when an underline line is actually present.
- **List-line fast check.** The six block-begin regexes a list item tests
  per continuation line are skipped when the line's first non-space
  character cannot start any of them; tab expansion is skipped when the
  line has no tab.
- **Memoized per-indent regexes** (indent clamped to 0..3, as in marked),
  so each composite regex compiles once.

## Correctness

Verified against the kit's practice set with the kit scorer:

```
{"passed": 1, "cases_passed": 720, "cases_total": 720}
```

720/720 cases byte-identical to marked 18.1.3, including all 680
CommonMark 0.31.2 + GFM 0.29 spec examples and all 40 generated README
documents. The parser is general: it does not recognize, cache, or look
up any input; every case is rendered from scratch.

## Speed

Parse-only time over the 720 practice cases (median of 5 runs, same
machine, alternating with the house baseline):

| | time | speedup |
|---|---|---|
| house baseline (marked 18.1.3) | 2575 ms | 1.00x |
| this entry | 1898 ms | 1.36x |

On the 40 long documents alone (the part that dominates CPU):
baseline 2795 ms, this entry 2040 ms (1.37x median, 1.69x best run).

## Layout

- `parse.js` — the parser (ES module, no dependencies). Exports `parse`.
- `main.ts` — the driver: reads `cases.json`, renders each case alone,
  writes `html.json`. Node 22, erasable syntax only.
- `package.json` — `{"type": "module"}`.

## License

MIT. The parser is a fork of marked 18.1.3 (MIT); see `LICENSE` for the
full text and the original copyright notice.
