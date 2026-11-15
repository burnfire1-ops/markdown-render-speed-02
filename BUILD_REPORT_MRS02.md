# BUILD REPORT — markdown-render-speed-02

## Entry

- Repository: `burnfire1-ops/markdown-render-speed-02`
- Entry point: `main.ts` (Node 22, erasable syntax only) + `parse.js`
  (ES module, no dependencies).
- `parse(markdown)` returns exactly the HTML marked 18.1.3 renders with
  its default options (GFM on, breaks off, pedantic off, async off).

## Approach

A fork of marked 18.1.3, restructured and optimized for speed. Every
optimization is semantics-preserving; the parser is general (no input
recognition, no caching across cases, no lookup of any case's HTML).

1. **Plain-text inline fast path.** An inline source with no inline
   constructs at all (no `` ` ``, `~`, `\`, `<`, `[`, `!`, `*`, `_`, `&`,
   `www.`, `://`, `mailto:`, `xmpp:`, `@`, or a hard break) skips the
   whole inline tokenizer and becomes one text token. ~76% of inline
   sources in README-like documents take this path (30% of inline chars).
2. **First-character dispatch in the inline loop.** Each inline tokenizer
   runs only when the current character can start it, instead of ~10
   anchored regexes at every position. Bare-URL detection is pre-checked
   with a cheap prefix/`@` test before the URL regex runs.
3. **First-character dispatch in the block loop**, plus a cheap setext
   pre-check bounded to the first blank line, so the lheading regex only
   runs when an underline line is actually present.
4. **List-line fast check.** The six block-begin regexes a list item
   tests per continuation line are skipped when the line's first
   non-space character cannot start any of them; tab expansion is
   skipped when the line has no tab.
5. **Memoized per-indent regexes** (indent clamped to 0..3, as in marked).

Profiling that drove the work (40 long docs, CPU profile): the inline
text regex was 7.3% of baseline CPU, `list` 12.8%, `emStrong` 5.0%,
block lexing 2.9%. The fast path cut the inline-text regex share to
~4%; the setext pre-check and list fast check moved the long-doc
speedup from ~1.0x to ~1.4x.

## Correctness evidence

Kit scorer on the practice set (720 cases: 680 CommonMark 0.31.2 + GFM
0.29 spec examples + 40 generated README documents):

```
{"passed": 1, "cases_passed": 720, "cases_total": 720}
```

720/720 byte-identical to marked 18.1.3. Determinism: two runs of
`main.ts` produce byte-identical `html.json` (sha256
`e7e89c4fba2c45b1c4aa96c46c987e46c75a9fcdd08916b58ae7f2a7d7851724`).

Bugs found and fixed during verification (all caught by the scorer or
by a smoke suite of 26 targeted inputs compared against marked):
- Table regex missing its final `)` (syntax error).
- `del` reassigned a `const` opener variable in its closer loop
  (`TypeError: Assignment to constant variable`).
- Indented-code match kept trailing blank lines (missing marked's `ge`
  trimmer — now `trimBlankLines`).
- Fenced-code tokens were merged into a preceding paragraph (only
  indented code merges; fences push directly, as in marked's
  `blockTokens`).
- `blockTokens` paragraph-merge flag now matches marked (cleared after
  the first paragraph in a call).

## Speed

Practice set, same machine, entry and house baseline alternating
(parse-only, median of 5 runs; `main.ts` wall, median of 3 runs):

| measurement | baseline (marked 18.1.3) | this entry | speedup |
|---|---|---|---|
| parse-only, all 720 | 2575 ms | 1898 ms | 1.36x |
| parse-only, 40 long docs | 2795 ms | 2040 ms | 1.37x |
| `main.ts` wall, all 720 | 4769 ms | 3024 ms | 1.58x |

Best-run parse-only speedup: 1.65x (all 720), 1.69x (40 docs).
The 680 spec examples take ~10 ms in either implementation; the 40
long documents dominate CPU in both.

## Size

Repository (excluding `.git`): 98,100 bytes — well under the 1 MiB
cap. `parse.js` is 66,315 bytes. No dependencies, no network, no
native/WASM code.

## Files

- `parse.js` — the parser. Exports `parse`.
- `main.ts` — driver: reads `cases.json` (`{id, markdown}`), renders
  each case alone, writes `html.json` (JSON array of HTML strings, in
  order). Uses `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` outside the
  container, `/input` / `/output` inside it.
- `README.md` — with the competition's 3 live make.fun badges.
- `LICENSE` — MIT (first line `SPDX-License-Identifier: MIT`).
- `package.json` — `{"type": "module"}`.

## Status

Built and verified locally. NOT pushed, NOT submitted, NOT bundled or
checked — the parent handles those steps. Commit is local only.
