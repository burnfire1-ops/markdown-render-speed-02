# markdown-render-speed-02 — v5 (index scanner)

An original index/char-code scanner that renders Markdown to exactly the
HTML `marked` 18.1.3 produces with default options, without building a token
tree and without regex dispatch in the hot paths.

## Idea

The input is walked with explicit indices and `charCodeAt` comparisons.
Blocks are recognised by scanning line starts (a small `blockStartAt`
classifier); inline content is rendered by a single left-to-right scan
(`inlineRange`) that dispatches on the character code at each position.
Emphasis, links, autolinks, code spans, tags and entities are resolved by
small hand-written matchers (`tryEmStrong`, `tryInlineLink`,
`tryReflink`, `tryCodespan`, `tryTag`, `tryAutolink`, `tryUrlAt`) that
mirror marked's precedence rules, including the De rule (a link label that
itself contains a markdown link rejects the outer link) and the "ordered
list interrupts a paragraph only from 1" rule at top level (any number
interrupts inside a list item).

## Files

- `parse.js` — the whole renderer. `parse(markdown)` returns the HTML
  string. Dependency-free ES module.
- `main.ts` — entry runner: reads `cases.json` from `MAKEFUN_INPUT_DIR`
  (default `/input`), renders each case alone, writes `html.json` to
  `MAKEFUN_OUTPUT_DIR` (default `/output`).
- `package.json` — package metadata (no dependencies).
- `LICENSE` — MIT.

## Status

Work in progress. The diff harness against marked 18.1.3 on the 720
practice cases currently passes 673/720. The remaining failures cluster
in tab expansion inside code blocks reached through nested list/blockquote
dedenting (the tab's column shifts when the indent is stripped), a few
loose/tight list determinations, and blockquote edge cases. See
`BUILD_REPORT_MRS02_V5.md` for the full list.

## Build

No build step. `node main.ts` runs directly (erasable TypeScript).
`node --check parse.js` verifies the renderer parses.
