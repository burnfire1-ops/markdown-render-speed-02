// Driver for the markdown-render-speed-02 entry.
// Reads the case list, renders each case alone with parse(), and writes the
// results as a JSON array of HTML strings, in order.
//
// Input:  $MAKEFUN_INPUT_DIR/cases.json (or /input/cases.json in the container)
// Output: $MAKEFUN_OUTPUT_DIR/html.json (or /output/html.json in the container)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
