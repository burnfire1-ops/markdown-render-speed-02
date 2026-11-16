// main.ts — markdown-render-speed-02 entry runner (v5 index scanner).
// Reads cases.json (a JSON array of {id, markdown}) from MAKEFUN_INPUT_DIR
// (default /input), renders each case ALONE with parse(), writes html.json
// (a JSON array of HTML strings, one per case, in order) to
// MAKEFUN_OUTPUT_DIR (default /output). Node 22, erasable TS only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";

const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";

const raw = readFileSync(inputDir + "/cases.json", "utf8");
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const html: string[] = [];
for (const c of cases) {
  html.push(parse(c.markdown));
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(outputDir + "/html.json", JSON.stringify(html));
