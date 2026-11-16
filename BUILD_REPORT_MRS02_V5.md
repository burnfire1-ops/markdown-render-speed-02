# BUILD REPORT — markdown-render-speed-02 v5 (index scanner)

## Summary

v5 is an ORIGINAL index/char-code scanner: it walks the input with explicit
indices and `charCodeAt` comparisons, no token tree, no regex dispatch in
the hot paths. It renders Markdown to marked-18.1.3-exact HTML by
hand-written block and inline matchers that mirror marked's precedence
rules.

**Status: NOT submittable.** The kit scorer passes **676/720**
(`{"passed":0,"cases_passed":676,"cases_total":720}`). The gate requires
720/720. The speed premise IS validated: v5 is 2.6x faster than marked
and 2.1x faster than fork #3 (see Speed). The remaining work is
correctness, dominated by tab expansion inside code blocks reached through
nested list/blockquote dedenting.

## Files (repo `~/workspace/makefun/markdown-render/repo`)

| file | bytes |
|---|---|
| parse.js | 102,488 |
| main.ts | 904 |
| README.md | 1,928 |
| LICENSE | 1,086 |
| package.json | 227 |
| BUILD_REPORT_MRS02_V5.md | (this file) |
| **total** | **106,633** (limit 1,048,576) |

All six files were fresh-written with the builder's own write/edit calls.
No commit, push, bundle, check, or submit was performed.

## Verification

- `node --check parse.js` — OK.
- Kit scorer (program/scorer/main.ts, practice input + reference):
  `{"passed":0,"cases_passed":676,"cases_total":720}` (re-run after the
  final fixes; the diff harness agrees at 676/720).
- Determinism: two `main.ts` runs byte-identical.
  sha256(html.json) = `77e8542ea145567a41ba8282bacc146be4834f676310b713859d5e622d2e60ad`
  (this is the hash of v5's output, NOT the target
  `e7e89c4fba2c45b1c4aa96c46c987e46c75a9fcdd08916b58ae7f2a7d7851724`,
  which is the hash of marked's correct output — it will match only at
  720/720).
- Fallback count: 0/720 (no marked-fork fallback in the entry; the fork
  was used only as a benchmark reference in /tmp).

## Speed (parse-only, median of 9, alternating, load < 1 throughout)

Harness `/tmp/mrs02v5/speed-v5.mjs` (v5 vs vendored marked 18.1.3 vs
fork #3 extracted from commit 9aca2da to `/tmp/mrs02v5/fork3-parse.js`,
benchmark only, never copied into the entry).

| entry | median ms (720 cases) |
|---|---|
| v5 | 1,895.1 |
| marked 18.1.3 | 4,932.9 |
| fork #3 (9aca2da) | 3,997.4 |

- **v5 vs marked: 2.603x faster**
- **v5 vs fork #3: 2.109x faster**
- fork #3 vs marked: 1.234x (agrees with the earlier 1.16x–1.25x range)

The index-scanner premise is validated on speed: even at 676/720 the
renderer is more than twice as fast as the fork. The work remaining is
pure correctness.

## Correctness — what was fixed this build

Inline (all verified against the diff harness):

- Emphasis closer scan skips backslash escapes, code spans, links
  (`skipLinkAt`) and tags/autolinks.
- `_` intraword rule: `tryEmStrong` returns a skip signal (`t:-1`) so the
  text run stays intact (fixed cm-386/388 without breaking gfm-632).
- `isEscapedAt` helper; `p2IsDelim` ignores escaped delimiters
  (cm-437/440/449/452).
- `tryTag`: closing tag has no attributes; comment search from `i+2`
  (cm-624/626); valueless attribute rewinds to `nameEnd` (cm-616).
- Type 7 HTML block: tag must end on its own line (cm-642/643).
- `backpedalUrl` drops a trailing entity-like `&word;` (gfm-627).
- `matchMailto`: xmpp href is the raw text, mailto href is
  `"mailto:" + email` (gfm-633/634/635).
- De rule: on `labSt.e`, emit the opening bracket as literal text and
  return `action.at + 1` (cm-518/519/532/533); link `st.e` is set before
  the text-mode return so the rule fires for alt text (cm-520).
- **De rule scope (this build): `st.e` is set ONLY by markdown links
  (t6), not by autolinks (t10) or bare URLs/emails (t8).** An autolink
  `<...>` inside a label becomes a nested `<a>` and does NOT reject the
  outer link (doc-04). Bare URLs/emails are NOT linkified inside a label
  at all (marked probe: `[of www.ivory.com](...)` keeps the `www.` plain);
  the `inLink` gates on the `w/h/f/m/x`, `@` and `:` triggers were
  restored after a brief removal over-linkified doc-06.
- Empty-label defs rejected in `tryDef` and at dispatch sites (cm-552).
- Image in text mode pushes alt text only, not an `<img>` (cm-574).
- Codespan returns null when preceded by a backtick (cm-347).
- Tight paragraphs emit no trailing `"\n"` (cm-294/296/320/321/323).

Blocks:

- Blockquote `lastIsPara` allows nested blockquote/list lines as open;
  lazy continuation strips up to 4 leading spaces (except setext-looking
  lines, which get 4 spaces prepended).
- List item lazy continuation strips up to the content indent and rejects
  list-marker lines.
- Empty list item ends at a blank line.
- HTML types 1–5 strip the trailing `"\n"` only when the next line exists
  and is blank.
- Fence: trailing blank line contributes no extra `"\n"`.
- **Loose/tight (this build):** a blank line makes the list loose when it
  separates blocks at the item's own level. The rule is: it counts if the
  previous line is NOT a nested list item, OR the next non-blank line's
  indent is `<= ind.indent`; never inside a fenced code block
  (`inFenceLines` helper). This fixed cm-264/270/271 (indented code is a
  direct child, so it counts) and cm-307/318/319/324/325.
- **Varying-indent lists (this build):** a new item belongs to the list
  when its indent is `<= prevIndent + 1` and `<= sp + 3`; after a blank
  line the cap resets to `sp + 3`. The list loop skips blank lines
  between items. Fixed cm-295/310/311/313/315.
- **`newItemAt` takes a `maxIndent` parameter** and returns the item's
  indent; `itemIndent` is called with the item's own marker column.
- **Ordered list interrupting a paragraph (this build):** the "starts
  with 1" restriction applies only at top level. `blockStartAt` takes an
  `inList` flag; `parseParagraphTight` (list-item content only) passes
  true, so any number interrupts inside a list item (marked probe C).
  Fixed the doc-04/10/27/30/37 nested-list cases.
- **Task checkbox placement (this build):** in a loose list the `<input>`
  goes inside the `<p>` (inserted after the first `<p>` element); in a
  tight list it goes right after `<li>`. Fixed doc-32.
- **`stripIndent` straddling tab:** a tab that crosses the strip boundary
  contributes its remainder as spaces (fixed cm-009, cm-005).
- **`expandLeadingTabs` (this build):** expands leading tabs to spaces at
  a given start column, applied to list-item content lines so downstream
  fence/indented-code handlers see correct columns. Fixed cm-005.

## Remaining failures (44 at 676/720)

- **Tab expansion in code blocks (largest cluster, ~13 docs + cm-006/007):**
  a tab inside a code block reached through nested list/blockquote
  dedenting must expand by its ORIGINAL column, but each dedent stage
  shifts the column. `expandLeadingTabs` at the list level fixed cm-005
  and moved several docs forward, but blockquote-nested tabs (doc-11
  expects 1 space, got 3; doc-12 tab not expanded at all) still need the
  column tracked through the blockquote stage. The correct fix is to
  carry the column offset through dedenting (or expand tabs during each
  strip using the original column); it was not completed in this session.
- **cm-470** — nested emphasis `*foo __bar *baz bim__ bam*`: the outer
  `*` must pair with the final `*` so the em spans the inner strong.
  The closer-precedence choice in `tryEmStrong` picks the inner closer.
- **cm-312** — `    - e` at indent 4 should be a lazy continuation of
  the `d` paragraph (text `- e`), not a nested list. A list-marker line
  indented past `sp + 3` and shallower than the content indent is a lazy
  continuation; the first attempt at this rule broke cm-302 (different
  delimiter must stay a separate list) and was reverted.
- **cm-174 / cm-238 / cm-241** — blockquote edge cases: HTML-block
  trailing newline inside a quote; a lazy line that looks like a list
  item; a `>`-only line with trailing spaces contributing a single space
  to the paragraph.
- **Loose/tight (doc-02/10/26/30/31/36)** — a few lists are judged loose
  when marked judges them tight (or vice versa), mostly around blank
  lines inside nested structures.
- **List split (doc-03/16/19)** — `</ul><ul>` where marked keeps one
  list; varying-indent items after blank lines in generated READMEs.
- **Misc docs (doc-01/08/13/14/15/17/18/20/21/22/24/25/33/34)** —
  blockquote termination, a link whose URL contains `]`, HTML-block
  trailing newline, table edge cases, paragraph/heading boundaries.

## Harness notes

- `/tmp` is wiped on VM restarts; the diff harness
  (`/tmp/mrs02v5/diff.mjs`) and speed harness (`/tmp/mrs02v5/speed-v5.mjs`)
  were rebuilt from the kit after the ~16:07 and ~18:04 WIB restarts.
  Both are one-file scripts and are trivially recreatable.
- `parse.js` mtime reads 09:07 UTC (16:07 WIB) because of the VM
  restart; the content is current (all fixes above verified present by
  grep and by the diff harness). Do not trust the mtime.
- Recorder 01a1e368 was running for the whole build (started 15:10 WIB).
  Do NOT seal, commit, push, bundle, check, or submit from this session.
