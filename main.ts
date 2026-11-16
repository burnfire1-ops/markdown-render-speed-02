// Driver for the markdown-render-speed-02 entry (Node 22, types stripped
// natively, erasable syntax only). It reads every case from
// /input/cases.json (or $MAKEFUN_INPUT_DIR outside a container), renders
// each case alone with parse() from parse.js, and writes the HTML strings in
// order to /output/html.json (or $MAKEFUN_OUTPUT_DIR).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(inputDir, "cases.json"), "utf8")) as {
  id: string;
  markdown: string;
}[];

const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "html.json"), JSON.stringify(html));
