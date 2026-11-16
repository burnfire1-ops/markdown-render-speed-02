/**
 * marked v18.1.3 fork — a faster drop-in for marked 18.1.3 (default options).
 *
 * Based on marked 18.1.3 (MIT, https://github.com/markedjs/marked, tag v18.1.3):
 * Copyright (c) 2018-2026, MarkedJS. (MIT License)
 * Copyright (c) 2011-2018, Christopher Jeffrey. (MIT License)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 * This fork reproduces marked's parsing behaviour exactly for its default
 * options (GFM on, breaks off, pedantic off, async off) and speeds up the hot
 * paths: a plain-text inline fast path, first-character dispatch in the inline
 * loop, cheap pre-checks before the backtracking block regexes, a fast check
 * for list continuation lines, and memoized per-indent regexes.
 */

// Memoize a regex factory by indent level (clamped to 0..3).
function memoIndent(factory) {
  const cache = [];
  return (indent) => {
    const n = Math.max(0, Math.min(3, indent - 1));
    return cache[n] || (cache[n] = factory(n));
  };
}

// Tiny regex builder: start from a pattern, fill named holes, build the regex.
// When a replacement pattern is inlined, a `^` anchor inside it (other than
// one following `[`) is dropped, so the inlined piece works mid-pattern.
function rx(pattern, flags = "") {
  let src = typeof pattern === "string" ? pattern : pattern.source;
  return {
    replace(search, replacement) {
      let rep = typeof replacement === "string" ? replacement : replacement.source;
      rep = rep.replace(RX.caret, "$1");
      src = src.replace(search, rep);
      return this;
    },
    getRegex() {
      return new RegExp(src, flags);
    },
  };
}

// Block-level tag names (used by the HTML block and HTML-begin checks).
const BLOCK_TAGS = "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const COMMENT_RX = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// Shared small regexes.
const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  caret: /(^|[^\[])\^/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  // Per-marker list-item regex (cached: a list reuses one marker string).
  listItemRegex: (() => {
    const cache = new Map();
    return (marker) => {
      let re = cache.get(marker);
      if (!re) {
        re = new RegExp(`^( {0,3}${marker})((?:[ \t][^\\n]*)?(?:\\n|$))`);
        cache.set(marker, re);
      }
      return re;
    };
  })(),
  nextBulletRegex: memoIndent((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: memoIndent((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, "i")),
  blockquoteBeginRegex: memoIndent((n) => new RegExp(`^ {0,${n}}>`)),
};

// ---------------------------------------------------------------------------
// Block rules (GFM set)
// ---------------------------------------------------------------------------

const NEWLINE_RX = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE_RX = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const FENCES_RX = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const HR_RX = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const HEADING_RX = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULL_RX = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
// Setext heading base: the words "bull", "blockCode", ... are holes filled below.
const LHEADING_BASE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const LHEADING_RX = rx(LHEADING_BASE)
  .replace(/bull/g, BULL_RX)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const PARA_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const TEXT_RX = /^[^\n]+/;
const LABEL_RX = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const DEF_RX = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace("label", LABEL_RX)
  .replace("title", /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const LIST_RX = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULL_RX).getRegex();
const HTML_BLOCK_RX = rx("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i")
  .replace("comment", COMMENT_RX)
  .replace("tag", BLOCK_TAGS)
  .replace("attribute", / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();
const TABLE_RX = rx("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace("hr", HR_RX)
  .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
  .replace("blockquote", " {0,3}>")
  .replace("code", "(?: {4}| {0,3}\t)[^\\n]")
  .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
  .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]")
  .replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)")
  .replace("tag", BLOCK_TAGS)
  .getRegex();
// Paragraph regex for a given list-bullet interruption pattern.
function paraRegexFor(bulletPattern) {
  return rx(PARA_BASE)
    .replace("hr", HR_RX)
    .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
    .replace("|lheading", "")
    .replace("|table", "")
    .replace("blockquote", " {0,3}>")
    .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
    .replace("list", bulletPattern)
    .replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)")
    .replace("tag", BLOCK_TAGS)
    .getRegex();
}
// Blockquote body: the "(paragraph)" hole is the bullet paragraph regex.
const BLOCKQUOTE_RX = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace("paragraph", paraRegexFor(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)).getRegex();
// GFM paragraph: only an ordered list starting with 1 interrupts a paragraph.
const PARA_GFM_RX = rx(PARA_BASE)
  .replace("hr", HR_RX)
  .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
  .replace("|lheading", "")
  .replace("table", TABLE_RX)
  .replace("blockquote", " {0,3}>")
  .replace("fences", " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)")
  .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]")
  .replace("html", " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)")
  .replace("tag", BLOCK_TAGS)
  .getRegex();

const BLOCK_GFM = {
  blockquote: BLOCKQUOTE_RX,
  code: INDENTED_CODE_RX,
  def: DEF_RX,
  fences: FENCES_RX,
  heading: HEADING_RX,
  hr: HR_RX,
  html: HTML_BLOCK_RX,
  lheading: LHEADING_RX,
  list: LIST_RX,
  newline: NEWLINE_RX,
  paragraph: PARA_GFM_RX,
  table: TABLE_RX,
  text: TEXT_RX,
};

// Cheap necessary-condition pre-checks for the backtracking block regexes.
// Each is a tiny test that must pass for the full regex to be able to match.
const MAYBE_SETEXT = /\n {0,3}[=-]/;
const MAYBE_TABLE = /\n {0,3}\|? *:?-/;
const MAYBE_HTML = /^ {0,3}</;

// ---------------------------------------------------------------------------
// Inline rules (GFM set)
// ---------------------------------------------------------------------------

const ESCAPE_RX = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODESPAN_RX = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RX = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const PUNCT_RX = /[\p{P}\p{S}]/u;
const PUNCT_SPACE_RX = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_RX = /[^\s\p{P}\p{S}]/u;
const PUNCTUATION_RX = rx(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, PUNCT_SPACE_RX).getRegex();
const OPEN_QUOTE_RX = /[\p{Pi}\p{Ps}"']/u;
const PUNCT_NO_TILDE_RX = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE_RX = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE_RX = /(?:[^\s\p{P}\p{S}]|~)/u;
// Lookbehind support (Node 22 has it; tested once at load).
const HAS_LOOKBEHIND = (() => {
  try {
    return !!new RegExp("(?<=1)(?<!1)");
  } catch {
    return false;
  }
})();
const BLOCK_SKIP_RX = rx(/link|precode-code|html/, "g")
  .replace("link", /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace("precode-", HAS_LOOKBEHIND ? "(?<!`)()" : "(^^|[^`])")
  .replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace("html", /<(?! )[^<>]*?>/)
  .getRegex();
const EM_STRONG_L_BASE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_L_RX = rx(EM_STRONG_L_BASE, "u").replace(/punct/g, PUNCT_NO_TILDE_RX).getRegex();
const EM_STRONG_R_AST_BASE = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const EM_STRONG_R_AST_RX = rx(EM_STRONG_R_AST_BASE, "gu")
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE_RX)
  .replace(/punctSpace/g, PUNCT_SPACE_NO_TILDE_RX)
  .replace(/punct/g, PUNCT_NO_TILDE_RX)
  .getRegex();
const EM_STRONG_R_UND_RX = rx("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)", "gu")
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_RX)
  .replace(/punctSpace/g, PUNCT_SPACE_RX)
  .replace(/punct/g, PUNCT_RX)
  .getRegex();
const DEL_L_RX = rx(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, PUNCT_RX).getRegex();
const DEL_R_BASE = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const DEL_R_RX = rx(DEL_R_BASE, "gu")
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_RX)
  .replace(/punctSpace/g, PUNCT_SPACE_RX)
  .replace(/punct/g, PUNCT_RX)
  .getRegex();
const ANY_PUNCT_RX = rx(/\\(punct)/, "gu").replace(/punct/g, PUNCT_RX).getRegex();
const ANY_PUNCT_OUTSIDE_CODE_RX = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu").replace(/punct/g, PUNCT_RX).getRegex();
const AUTOLINK_RX = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace("email", /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const TAG_RX = rx("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
  .replace("comment", rx(COMMENT_RX).replace("(?:-->|$)", "-->").getRegex())
  .replace("attribute", /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
const BRACKETS_RX = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_CONTENT_RX = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace("brackets", BRACKETS_RX).getRegex();
const LINK_RX = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace("label", LABEL_CONTENT_RX)
  .replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace("title", /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const REFLINK_RX = rx(/^!?\[(label)\]\[(ref)\]/).replace("label", LABEL_CONTENT_RX).replace("ref", LABEL_RX).getRegex();
const NOLINK_RX = rx(/^!?\[(ref)\](?:\[\])?/).replace("ref", LABEL_RX).getRegex();
const REF_LABEL_RX = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_LABEL_RX = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace("brackets", BRACKETS_RX).getRegex();
const REFLINK_SEARCH_RX = rx("reflink|nolink(?!\\()", "g")
  .replace("reflink", rx(/^!?\[(label)\]\[(ref)\]/).replace("label", REFLINK_LABEL_RX).replace("ref", REF_LABEL_RX).getRegex())
  .replace("nolink", rx(/^!?\[(ref)\](?:\[\])?/).replace("ref", REF_LABEL_RX).getRegex())
  .getRegex();
const PROTOCOL_RX = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_RX = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL_RX = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_RX).getRegex();
const URL_RX = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace("emailProtocol", EMAIL_PROTOCOL_RX)
  .replace("protocol", PROTOCOL_RX)
  .replace("email", /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const TEXT_GFM_RX = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace("protocol", PROTOCOL_RX)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace("wwwStart", HAS_LOOKBEHIND ? "(?<![^\\s*_~(])www\\." : "www\\.")
  .getRegex();

const INLINE_GFM = {
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  anyPunctuation: ANY_PUNCT_RX,
  anyPunctuationOutsideCode: ANY_PUNCT_OUTSIDE_CODE_RX,
  autolink: AUTOLINK_RX,
  blockSkip: BLOCK_SKIP_RX,
  br: BR_RX,
  code: CODESPAN_RX,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: DEL_L_RX,
  delRDelim: DEL_R_RX,
  emStrongLDelim: EM_STRONG_L_RX,
  emStrongRDelimAst: EM_STRONG_R_AST_RX,
  emStrongRDelimUnd: EM_STRONG_R_UND_RX,
  escape: ESCAPE_RX,
  link: LINK_RX,
  nolink: NOLINK_RX,
  punctuation: PUNCTUATION_RX,
  reflink: REFLINK_RX,
  reflinkSearch: REFLINK_SEARCH_RX,
  tag: TAG_RX,
  text: TEXT_GFM_RX,
  url: URL_RX,
};

// Characters that can start an inline token (plus & which changes decoding).
// The plain-text fast path fires only when none of these appear.
const INLINE_TRIGGER_RX = /[`*_~\[!<>\\&]/;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeChar = (ch) => ESCAPE_MAP[ch];

// Escape HTML characters. When `encode` is true, `&` is escaped too;
// otherwise only `&` that does not start a valid entity/reference is.
function escapeHtml(str, encode) {
  if (encode) {
    if (RX.escapeTest.test(str)) return str.replace(RX.escapeReplace, escapeChar);
  } else if (RX.escapeTestNoEncode.test(str)) {
    return str.replace(RX.escapeReplaceNoEncode, escapeChar);
  }
  return str;
}

// Decode numeric character references; a bare `&` that starts no valid
// reference becomes `&amp;`.
function unescapeEntities(str) {
  return RX.numericCharacterReference.test(str)
    ? str.replace(RX.numericCharacterReferenceOrAmpersand, (match, dec, hex) => {
        if (dec === undefined && hex === undefined) return "&amp;";
        const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
        if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return "\uFFFD";
        if (code === 38) return "&amp;";
        return String.fromCodePoint(code);
      })
    : str;
}

function encodeHref(href) {
  try {
    return encodeURI(href).replace(RX.percentDecode, "%");
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes, trimming cells and dropping empty
// edge cells; pad or cut to `count` cells when given.
function splitTableRow(row, count) {
  const cells = row
    .replace(RX.findPipe, (ch, offset, str) => {
      let escaped = false, i = offset;
      for (; --i >= 0 && str[i] === "\\";) escaped = !escaped;
      return escaped ? "|" : " |";
    })
    .split(RX.splitPipe);
  let n = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push("");
  }
  for (; n < cells.length; n++) cells[n] = cells[n].trim().replace(RX.slashPipe, "|");
  return cells;
}

// Strip trailing runs of `char` (or of anything but `char` when `invert`).
function trimEndChars(str, char, invert) {
  const len = str.length;
  if (len === 0) return "";
  let n = 0;
  for (; n < len;) {
    const ch = str.charAt(len - n - 1);
    if (ch === char && !invert) n++;
    else if (ch !== char && invert) n++;
    else break;
  }
  return str.slice(0, len - n);
}

// Drop trailing blank lines, keeping at most one.
function trimTrailingBlankLines(str) {
  const lines = str.split("\n");
  let i = lines.length - 1;
  for (; i >= 0 && RX.blankLine.test(lines[i]);) i--;
  return lines.length - i <= 2 ? str : lines.slice(0, i + 1).join("\n");
}

// Normalize a link reference label for lookup.
function normalizeLabel(label) {
  return label.trim().replace(RX.multipleSpaceGlobal, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing paren that unbalances `open`/`close`,
// or -1 when balanced, -2 when the string ends inside a nested paren.
function findUnbalancedParen(str, parens) {
  if (str.indexOf(parens[0]) === -1 && str.indexOf(parens[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\\") i++;
    else if (str[i] === parens[0]) depth++;
    else if (str[i] === parens[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column from `start`.
function expandTabs(str, start = 0) {
  let col = start, out = "";
  for (const ch of str) {
    if (ch === "\t") {
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Build a link or image token from a link match and a reference.
function buildLinkToken(match, ref, raw, lexer, rules) {
  const text = match[1].replace(rules.other.outputLinkReplace, "$1");
  const isImage = match[0].charAt(0) === "!";
  const wasInLink = lexer.state.inLink;
  const wasEmitted = lexer.state.linkEmitted;
  const wasInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const inner = lexer.inlineTokens(text);
  const emitted = lexer.state.linkEmitted;
  if (lexer.state.linkEmitted = wasEmitted, lexer.state.inLink = wasInLink, !isImage) {
    if (emitted) {
      lexer.state.inRawBlock = wasInRawBlock;
      return;
    }
    lexer.state.linkEmitted = true;
  }
  return {
    type: isImage ? "image" : "link",
    raw,
    href: ref.href,
    title: ref.title || null,
    text,
    tokens: inner,
  };
}

// Compensate fenced-code indentation: lines indented less than the opening
// fence's indent lose that indent.
function compensateFenceIndent(raw, code, rules) {
  const m = raw.match(rules.other.indentCodeCompensation);
  if (m === null) return code;
  const indent = m[1];
  return code.split("\n").map((line) => {
    const lead = line.match(rules.other.beginningSpace);
    if (lead === null) return line;
    const [spaces] = lead;
    return line.slice(Math.min(spaces.length, indent.length));
  }).join("\n");
}

// Does `label` (starting at `offset` inside `fullStr`) contain a link whose
// label looks like a reference that exists? Used to keep `[a](b)`-shaped text
// out of emphasis.
function hasLinkInText(lexer, fullStr, label, offset, rules) {
  if (!label.includes("<")) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === "\\") { i++; continue; }
    if (label[i] === "`") {
      const m = lexer.rules.inline.code.exec(label.slice(i));
      if (m) { i += m[0].length - 1; continue; }
    }
    if (label[i] !== "<") continue;
    const rest = fullStr.slice(offset + i);
    const m = lexer.rules.inline.tag.exec(rest) || lexer.rules.inline.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Emphasis/delimiter mask cache: for a masked inline source, remember where
// the last possible emphasis/del closer can be, so the closers are only
// searched up to there.
const maskCache = new WeakMap();
function scanMask(src) {
  const lastEm = { "*": -1, _: -1 };
  let lastDel = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== "*" && ch !== "_" && ch !== "~") continue;
    const prev = i === 0 ? "\n" : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === ch;) j++;
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\r" && prev !== "\f") {
      if (ch === "~") lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastPossibleEmStrongCloserIndex: lastEm, lastPossibleDelCloserIndex: lastDel };
}
function pushMask(tokenizer, maskedSrc) {
  const entry = scanMask(maskedSrc);
  const stack = maskCache.get(tokenizer);
  if (stack) stack.push(entry);
  else maskCache.set(tokenizer, [entry]);
}
function popMask(tokenizer) {
  const stack = maskCache.get(tokenizer);
  if (stack) {
    stack.pop();
    if (stack.length === 0) maskCache.delete(tokenizer);
  }
}
function lastEmCloser(tokenizer, maskedSrc, delim) {
  const top = maskCache.get(tokenizer)?.at(-1);
  return top && top.maskedSrc === maskedSrc
    ? top.lastPossibleEmStrongCloserIndex[delim]
    : scanMask(maskedSrc).lastPossibleEmStrongCloserIndex[delim];
}
function lastDelCloser(tokenizer, maskedSrc) {
  const top = maskCache.get(tokenizer)?.at(-1);
  return top && top.maskedSrc === maskedSrc
    ? top.lastPossibleDelCloserIndex
    : scanMask(maskedSrc).lastPossibleDelCloserIndex;
}

// ---------------------------------------------------------------------------
// Tokenizer (block + inline). Only the GFM/default-options paths are kept:
// gfm is always on, pedantic/breaks/async are always off, no extensions,
// no hooks, no walkTokens.
// ---------------------------------------------------------------------------

class Tokenizer {
  constructor() {
    this.rules = { other: RX, block: BLOCK_GFM, inline: INLINE_GFM };
    this.lexer = null;
  }

  space(src) {
    const m = this.rules.block.newline.exec(src);
    if (m && m[0].length > 0) return { type: "space", raw: m[0] };
  }

  code(src) {
    const m = this.rules.block.code.exec(src);
    if (m) {
      const raw = trimTrailingBlankLines(m[0]);
      const text = raw.replace(this.rules.other.codeRemoveIndent, "");
      return { type: "code", raw, codeBlockStyle: "indented", text };
    }
  }

  fences(src) {
    const m = this.rules.block.fences.exec(src);
    if (m) {
      const raw = m[0];
      const text = compensateFenceIndent(raw, m[3] || "", this.rules);
      return {
        type: "code",
        raw,
        lang: m[2] ? m[2].trim().replace(this.rules.inline.anyPunctuation, "$1") : m[2],
        text,
      };
    }
  }

  heading(src) {
    const m = this.rules.block.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (this.rules.other.endingHash.test(text)) {
        const stripped = trimEndChars(text, "#");
        if (!stripped || this.rules.other.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return {
        type: "heading",
        raw: trimEndChars(m[0], "\n"),
        depth: m[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  hr(src) {
    const m = this.rules.block.hr.exec(src);
    if (m) return { type: "hr", raw: trimEndChars(m[0], "\n") };
  }

  blockquote(src) {
    const m = this.rules.block.blockquote.exec(src);
    if (m) {
      let lines = trimEndChars(m[0], "\n").split("\n");
      let raw = "", text = "";
      const tokens = [];
      for (; lines.length > 0;) {
        let inQuote = false;
        const chunk = [];
        let p;
        for (p = 0; p < lines.length; p++) {
          if (this.rules.other.blockquoteStart.test(lines[p])) {
            chunk.push(lines[p]);
            inQuote = true;
          } else if (!inQuote) chunk.push(lines[p]);
          else break;
        }
        lines = lines.slice(p);
        const joined = chunk.join("\n");
        const stripped = joined
          .replace(this.rules.other.blockquoteMarkerWhitespace, (g, lead, rest) => lead + expandTabs(rest, lead.length))
          .replace(this.rules.other.blockquoteSetextReplace, "\n    $1")
          .replace(this.rules.other.blockquoteSetextReplace2, "");
        raw = raw ? `${raw}\n${joined}` : joined;
        text = text ? `${text}\n${stripped}` : stripped;
        const savedTop = this.lexer.state.top;
        if (this.lexer.state.top = true, this.lexer.blockTokens(stripped, tokens, true), this.lexer.state.top = savedTop, lines.length === 0) break;
        const last = tokens.at(-1);
        if (last?.type === "code" || last?.type === "heading" || last?.type === "hr" || last?.type === "html" || last?.type === "table") break;
        if (last?.type === "blockquote") {
          const inner = last;
          const rest = lines.join("\n");
          const reparsed = inner.raw + "\n" + rest.replace(this.rules.other.blockquoteSetextReplace2, "");
          const again = this.blockquote(reparsed);
          tokens[tokens.length - 1] = again;
          const leftover = reparsed.substring(again.raw.length).replace(/^\n/, "");
          const leftoverLines = leftover ? leftover.split("\n").length : 0;
          const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
          if (consumed.length > 0) raw = `${raw}\n${consumed.join("\n")}`;
          text = text.substring(0, text.length - inner.text.length) + again.text;
          lines = lines.slice(consumed.length);
          if (lines.length > 0 && this.rules.other.blockquoteStart.test(lines[0])) continue;
          break;
        } else if (last?.type === "list") {
          const inner = last;
          const rest = inner.raw + "\n" + lines.join("\n");
          const again = this.list(rest);
          tokens[tokens.length - 1] = again;
          const extra = again.raw.length > inner.raw.length
            ? rest.slice(inner.raw.length + 1, again.raw.length).split("\n").length
            : 0;
          if (extra > 0) {
            const taken = lines.slice(0, extra).join("\n");
            raw = `${raw}\n${taken}`;
            text = `${text}\n${taken}`;
          }
          lines = lines.slice(extra);
          continue;
        }
      }
      return { type: "blockquote", raw, tokens, text };
    }
  }

  list(src) {
    const first = this.rules.block.list.exec(src);
    if (first) {
      const whole = src;
      const restLen = () => whole.length - src.length;
      const marker = first[1].trim();
      const ordered = marker.length > 1;
      const list = {
        type: "list",
        raw: "",
        ordered,
        start: ordered ? +marker.slice(0, -1) : "",
        loose: false,
        items: [],
      };
      const itemRe = this.rules.other.listItemRegex(ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`);
      let hasBlank = false;
      for (; src;) {
        let emptyItem = false;
        let itemText = "";
        let m;
        if (!(m = itemRe.exec(src)) || this.rules.block.hr.test(src)) break;
        const itemStart = restLen();
        src = src.substring(m[0].length);
        const firstLine = m[2].split("\n", 1)[0];
        const markerLen = m[1].length;
        let content = firstLine.replace(this.rules.other.leadingSpaceTab, (v) => expandTabs(v, markerLen));
        let nextLine = src.split("\n", 1)[0];
        let blankFirst = !content.trim();
        let indent = 0;
        if (blankFirst) indent = markerLen + 1;
        else {
          indent = content.search(this.rules.other.nonSpaceChar);
          if (indent > 4) indent = 1;
          itemText = content.slice(indent);
          indent += markerLen;
        }
        if (blankFirst && this.rules.other.blankLine.test(nextLine)) {
          src = src.substring(nextLine.length + 1);
          emptyItem = true;
        }
        if (!emptyItem) {
          const nextBullet = this.rules.other.nextBulletRegex(indent);
          const hrRe = this.rules.other.hrRegex(indent);
          const fencesRe = this.rules.other.fencesBeginRegex(indent);
          const headingRe = this.rules.other.headingBeginRegex(indent);
          const htmlRe = this.rules.other.htmlBeginRegex(indent);
          const quoteRe = this.rules.other.blockquoteBeginRegex(indent);
          for (; src;) {
            const line = src.split("\n", 1)[0];
            let expanded;
            nextLine = line;
            expanded = line.replace(this.rules.other.leadingSpaceTab, (v) => expandTabs(v));
            if (fencesRe.test(line) || headingRe.test(line) || htmlRe.test(line) || quoteRe.test(line) || nextBullet.test(line) || hrRe.test(line)) break;
            if (expanded.search(this.rules.other.nonSpaceChar) >= indent || !line.trim()) {
              itemText += "\n" + expanded.slice(indent);
            } else {
              if (blankFirst
                || content.replace(this.rules.other.tabCharGlobal, "    ").search(this.rules.other.nonSpaceChar) >= 4
                || fencesRe.test(content) || headingRe.test(content) || htmlRe.test(content) || hrRe.test(content)) break;
              const setextLine = /^ {0,3}(?:=+|-+) *$/.test(line) && this.rules.block.lheading.test(`${content}\n${line}`)
                ? `    ${expanded.replace(/^ {0,3}/, "")}`
                : line;
              itemText += "\n" + setextLine;
            }
            blankFirst = !line.trim();
            src = src.substring(line.length + 1);
            content = expanded.slice(indent);
          }
        }
        const itemRaw = whole.slice(itemStart, restLen());
        if (!list.loose) {
          if (hasBlank) list.loose = true;
          else if (this.rules.other.doubleBlankLine.test(itemRaw)) hasBlank = true;
        }
        list.items.push({
          type: "list_item",
          raw: itemRaw,
          task: this.rules.other.listIsTask.test(itemText),
          loose: false,
          text: itemText,
          tokens: [],
        });
      }
      const lastItem = list.items.at(-1);
      if (lastItem) {
        lastItem.raw = lastItem.raw.trimEnd();
        lastItem.text = lastItem.text.trimEnd();
      } else return;
      list.raw = whole.slice(0, restLen()).trimEnd();
      for (const item of list.items) {
        this.lexer.state.top = false;
        item.tokens = this.lexer.blockTokens(item.text, []);
        if (!list.loose) {
          const spaces = item.tokens.filter((t) => t.type === "space");
          list.loose = spaces.length > 0 && spaces.some((t) => this.rules.other.anyLine.test(t.raw));
        }
      }
      for (const item of list.items) {
        const firstTok = item.tokens[0];
        if (item.task && (firstTok?.type === "text" || firstTok?.type === "paragraph")) {
          item.text = item.text.replace(this.rules.other.listReplaceTask, "");
          firstTok.raw = firstTok.raw.replace(this.rules.other.listReplaceTask, "");
          firstTok.text = firstTok.text.replace(this.rules.other.listReplaceTask, "");
          for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
            if (this.rules.other.listIsTask.test(this.lexer.inlineQueue[i].src)) {
              this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(this.rules.other.listReplaceTask, "");
              break;
            }
          }
          const box = this.rules.other.listTaskCheckbox.exec(item.raw);
          if (box) {
            const checkbox = { type: "checkbox", raw: box[0] + " ", checked: box[0] !== "[ ]" };
            item.checked = checkbox.checked;
            if (list.loose) {
              if (item.tokens[0] && ["paragraph", "text"].includes(item.tokens[0].type)
                && "tokens" in item.tokens[0] && item.tokens[0].tokens) {
                item.tokens[0].raw = checkbox.raw + item.tokens[0].raw;
                item.tokens[0].text = checkbox.raw + item.tokens[0].text;
                item.tokens[0].tokens.unshift(checkbox);
              } else {
                item.tokens.unshift({ type: "paragraph", raw: checkbox.raw, text: checkbox.raw, tokens: [checkbox] });
              }
            } else {
              item.tokens.unshift(checkbox);
            }
          }
        } else if (item.task) item.task = false;
      }
      if (list.loose) {
        for (const item of list.items) {
          item.loose = true;
          for (const tok of item.tokens) if (tok.type === "text") tok.type = "paragraph";
        }
      }
      return list;
    }
  }

  html(src) {
    const m = this.rules.block.html.exec(src);
    if (m) {
      const raw = trimTrailingBlankLines(m[0]);
      return {
        type: "html",
        block: true,
        raw,
        pre: m[1] === "pre" || m[1] === "script" || m[1] === "style",
        text: raw,
      };
    }
  }

  def(src) {
    const m = this.rules.block.def.exec(src);
    if (m) {
      if (!this.rules.other.startAngleBracket.test(m[2]) && findUnbalancedParen(m[2], "()") !== -1) return;
      const tag = normalizeLabel(m[1]);
      const href = m[2]
        ? m[2].replace(this.rules.other.hrefBrackets, "$1").replace(this.rules.inline.anyPunctuation, "$1")
        : "";
      const title = m[3]
        ? m[3].substring(1, m[3].length - 1).replace(this.rules.inline.anyPunctuation, "$1")
        : m[3];
      return { type: "def", tag, raw: trimEndChars(m[0], "\n"), href, title };
    }
  }

  table(src) {
    const m = this.rules.block.table.exec(src);
    if (!m || !this.rules.other.tableDelimiter.test(m[2])) return;
    const headerCells = splitTableRow(m[1]);
    const alignParts = m[2].replace(this.rules.other.tableAlignChars, "").split("|");
    const bodyLines = m[3]?.trim() ? m[3].replace(this.rules.other.tableRowBlankLine, "").split("\n") : [];
    const table = { type: "table", raw: trimEndChars(m[0], "\n"), header: [], align: [], rows: [] };
    if (headerCells.length === alignParts.length) {
      for (const part of alignParts) {
        if (this.rules.other.tableAlignRight.test(part)) table.align.push("right");
        else if (this.rules.other.tableAlignCenter.test(part)) table.align.push("center");
        else if (this.rules.other.tableAlignLeft.test(part)) table.align.push("left");
        else table.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        table.header.push({ text: headerCells[i], tokens: this.lexer.inline(headerCells[i]), header: true, align: table.align[i] });
      }
      for (const line of bodyLines) {
        table.rows.push(splitTableRow(line, table.header.length).map((cell, i) => ({
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: table.align[i],
        })));
      }
      return table;
    }
  }

  lheading(src) {
    const m = this.rules.block.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: "heading",
        raw: trimEndChars(m[0], "\n"),
        depth: m[2].charAt(0) === "=" ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    const m = this.rules.block.paragraph.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === "\n" ? m[1].slice(0, -1) : m[1];
      return { type: "paragraph", raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }

  text(src) {
    const m = this.rules.block.text.exec(src);
    if (m) return { type: "text", raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }

  // --- Inline tokenizers ---

  escape(src) {
    const m = this.rules.inline.escape.exec(src);
    if (m) return { type: "escape", raw: m[0], text: m[1] };
  }

  tag(src) {
    const m = this.rules.inline.tag.exec(src);
    if (m) {
      if (!this.lexer.state.inLink && this.rules.other.startATag.test(m[0])) this.lexer.state.inLink = true;
      else if (this.lexer.state.inLink && this.rules.other.endATag.test(m[0])) this.lexer.state.inLink = false;
      if (!this.lexer.state.inRawBlock && this.rules.other.startPreScriptTag.test(m[0])) this.lexer.state.inRawBlock = true;
      else if (this.lexer.state.inRawBlock && this.rules.other.endPreScriptTag.test(m[0])) this.lexer.state.inRawBlock = false;
      return {
        type: "html",
        raw: m[0],
        inLink: this.lexer.state.inLink,
        inRawBlock: this.lexer.state.inRawBlock,
        block: false,
        text: m[0],
      };
    }
  }

  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = this.rules.inline.link.exec(src);
    if (m) {
      const bang = m[0].charAt(0) === "!" ? 2 : 1;
      if (hasLinkInText(this.lexer, src, m[1], bang, this.rules)) return;
      let href = m[2].trim();
      if (this.rules.other.startAngleBracket.test(href)) {
        if (!this.rules.other.endAngleBracket.test(href)) return;
        const stripped = trimEndChars(href.slice(0, -1), "\\");
        if ((href.length - stripped.length) % 2 === 0) return;
      } else {
        const close = findUnbalancedParen(m[2], "()");
        if (close === -2) return;
        if (close > -1) {
          const cut = (m[0].indexOf("!") === 0 ? 5 : 4) + m[1].length + close;
          m[2] = m[2].substring(0, close);
          m[0] = m[0].substring(0, cut).trim();
          m[3] = "";
        }
      }
      const trimmed = trimEndChars(m[0].slice(0, -1), "\\");
      if ((m[0].length - trimmed.length) % 2 === 0) return;
      let dest = m[2];
      let title = "";
      if (m[3]) title = m[3].slice(1, -1);
      dest = dest.trim();
      if (this.rules.other.startAngleBracket.test(dest)) dest = dest.slice(1, -1);
      return buildLinkToken(m, {
        href: dest && dest.replace(this.rules.inline.anyPunctuation, "$1"),
        title: title && title.replace(this.rules.inline.anyPunctuation, "$1"),
      }, m[0], this.lexer, this.rules);
    }
  }

  reflink(src, links) {
    let m;
    if ((m = this.rules.inline.reflink.exec(src)) || (m = this.rules.inline.nolink.exec(src))) {
      const bang = m[0].charAt(0) === "!" ? 2 : 1;
      if (hasLinkInText(this.lexer, src, m[1], bang, this.rules)) return;
      const ref = links[normalizeLabel(m[2] || m[1])];
      if (!ref) {
        const ch = m[0].charAt(0);
        return { type: "text", raw: ch, text: ch };
      }
      return buildLinkToken(m, ref, m[0], this.lexer, this.rules);
    }
  }

  emStrong(src, masked, prev = "") {
    const open = this.rules.inline.emStrongLDelim.exec(src);
    if (!open || (!open[1] && !open[2] && !open[3] && !open[4])) return;
    const delim = open[0][0];
    const isSameAsPrev = prev === delim;
    const pos = masked.length - src.length;
    let scan = pos;
    for (; scan > 0 && masked[scan - 1] === delim;) scan--;
    const before = [...masked.slice(Math.max(0, scan - 2), scan)].at(-1) ?? "";
    const beforeIsPunct = before === "*" || before === "_" || !!this.rules.inline.punctuation.exec(before);
    if (scan < pos) prev = before;
    const prevIsPunct = scan < pos ? beforeIsPunct : !!this.rules.inline.punctuation.exec(prev);
    if (open[4] && prev.match(this.rules.other.unicodeAlphaNumeric)) return;
    const inner = open[1] || open[3] || "";
    if (!inner || !prev || prevIsPunct) {
      const runLen = [...open[0]].length - 1;
      let closerLen = runLen;
      let extra = 0;
      const runTotal = pos - scan + runLen;
      const rule = !!before.trim() && (!!inner || (delim === "*" && !beforeIsPunct));
      if (delim !== "*" && delim !== "_") return;
      const closeRe = delim === "*"
        ? this.rules.inline.emStrongRDelimAst
        : this.rules.inline.emStrongRDelimUnd;
      const lastCloser = lastEmCloser(this, masked, delim);
      const minPos = masked.length - src.length + runLen;
      if (lastCloser < minPos) return;
      const rest = masked.slice(-1 * src.length + runLen);
      const limit = lastCloser - minPos;
      let match;
      for (closeRe.lastIndex = 0; (match = closeRe.exec(rest)) !== null && !(match.index > limit);) {
        const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!run) continue;
        let len = [...run].length;
        if (match[3] || match[4]) {
          closerLen += len;
          continue;
        } else if (match[5] || match[6] || rule) {
          if (isSameAsPrev && (match[5] || match[6])) break;
          if (runTotal % 3 && !((runTotal + len) % 3)) {
            extra += len;
            continue;
          }
        }
        if (closerLen -= len, closerLen > 0) continue;
        len = Math.min(len, len + closerLen + extra);
        const firstLen = [...match[0]][0].length;
        const whole = src.slice(0, runLen + match.index + firstLen + len);
        if (Math.min(runLen, len) % 2) {
          const innerText = whole.slice(1, -1);
          return { type: "em", raw: whole, text: innerText, tokens: this.lexer.inlineTokens(innerText) };
        }
        const strongText = whole.slice(2, -2);
        return { type: "strong", raw: whole, text: strongText, tokens: this.lexer.inlineTokens(strongText) };
      }
    }
  }

  codespan(src) {
    const m = this.rules.inline.code.exec(src);
    if (m) {
      let text = m[2].replace(this.rules.other.newLineCharGlobal, " ");
      const hasNonSpace = this.rules.other.nonSpaceChar.test(text);
      const padded = this.rules.other.startingSpaceChar.test(text) && this.rules.other.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: "codespan", raw: m[0], text };
    }
  }

  br(src) {
    const m = this.rules.inline.br.exec(src);
    if (m) return { type: "br", raw: m[0] };
  }

  del(src, masked, prev = "") {
    const open = this.rules.inline.delLDelim.exec(src);
    if (!open) return;
    if (!(open[1] || "") || !prev || this.rules.inline.punctuation.exec(prev)) {
      const runLen = [...open[0]].length - 1;
      let remaining = runLen;
      const closeRe = this.rules.inline.delRDelim;
      const lastCloser = lastDelCloser(this, masked);
      const minPos = masked.length - src.length + runLen;
      if (lastCloser < minPos) return;
      const rest = masked.slice(-1 * src.length + runLen);
      const limit = lastCloser - minPos;
      let match;
      for (closeRe.lastIndex = 0; (match = closeRe.exec(rest)) !== null && !(match.index > limit);) {
        const run = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
        if (!run) continue;
        let len = [...run].length;
        if (len !== runLen) continue;
        if (match[3] || match[4]) {
          remaining += len;
          continue;
        }
        if (remaining -= len, remaining > 0) continue;
        len = Math.min(len, len + remaining);
        const firstLen = [...match[0]][0].length;
        const whole = src.slice(0, runLen + match.index + firstLen + len);
        const innerText = whole.slice(runLen, -runLen);
        return { type: "del", raw: whole, text: innerText, tokens: this.lexer.inlineTokens(innerText) };
      }
    }
  }

  autolink(src) {
    const m = this.rules.inline.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === "@") {
        text = m[1];
        href = "mailto:" + text;
      } else {
        text = m[1];
        href = text;
      }
      return {
        type: "link",
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: "text", raw: text, text }],
      };
    }
  }

  url(src) {
    const m = this.rules.inline.url.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === "@") {
        text = m[0];
        href = "mailto:" + text;
      } else {
        let prev;
        do {
          prev = m[0];
          m[0] = this.rules.inline._backpedal.exec(m[0])?.[0] ?? "";
        } while (prev !== m[0]);
        text = m[0];
        href = m[1] === "www." ? "http://" + m[0] : m[0];
      }
      return {
        type: "link",
        raw: m[0],
        text,
        href,
        autolink: true,
        tokens: [{ type: "text", raw: text, text }],
      };
    }
  }

  inlineText(src) {
    const m = this.rules.inline.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: "text", raw: m[0], text: inRaw ? m[0] : unescapeEntities(m[0]), escaped: inRaw };
    }
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.inlineQueue = [];
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.rules = { other: RX, block: BLOCK_GFM, inline: INLINE_GFM };
    this.tokenizer.rules = this.rules;
  }

  lex(src) {
    src = src.replace(RX.carriageReturn, "\n");
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const item = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(item.src, item.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens, nested = false) {
    this.tokenizer.lexer = this;
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      let token;
      if (token = this.tokenizer.space(src)) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (token.raw.length === 1 && prev !== undefined) prev.raw += "\n";
        else tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.code(src)) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === "paragraph" || prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + token.raw;
          prev.text += "\n" + token.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.fences(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.heading(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.hr(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.blockquote(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.list(src)) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (MAYBE_HTML.test(src) && (token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (token = this.tokenizer.def(src)) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === "paragraph" || prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + token.raw;
          prev.text += "\n" + token.raw;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = { href: token.href, title: token.title };
          }
          tokens.push(token);
        }
        continue;
      }
      if (MAYBE_TABLE.test(src) && (token = this.tokenizer.table(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (MAYBE_SETEXT.test(src) && (token = this.tokenizer.lheading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (this.state.top && (token = this.tokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (nested && prev?.type === "paragraph") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + token.raw;
          prev.text += "\n" + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(token);
        // After the first paragraph of a nested block, later paragraphs no
        // longer merge with the previous one.
        nested = false;
        src = src.substring(token.raw.length);
        continue;
      }
      if (token = this.tokenizer.text(src)) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + token.raw;
          prev.text += "\n" + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else tokens.push(token);
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    this.state.top = true;
    return tokens;
  }

  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  linkInText(src) {
    if (!src.includes("[")) return false;
    const linkRe = this.tokenizer.rules.inline.link;
    for (const m of src.matchAll(this.tokenizer.rules.inline.blockSkip)) {
      if (linkRe.test(m[0]) && src.charAt(m.index - 1) !== "!") return true;
    }
    for (const m of src.matchAll(this.tokenizer.rules.inline.reflinkSearch)) {
      const whole = m[0];
      const open = whole.lastIndexOf("[");
      if (!(whole.charAt(0) === "!" || !Object.hasOwn(this.tokens.links, normalizeLabel(whole.slice(open + 1, -1))))
        && !(open > 1 && this.linkInText(whole.slice(1, open - 1)))) return true;
    }
    return false;
  }

  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    // Plain-text fast path: no inline markup can start here, so the whole
    // source is one text token. Only valid outside raw blocks (inside
    // <pre>/<script> the text must pass through unescaped).
    if (!this.state.inRawBlock
      && !INLINE_TRIGGER_RX.test(src)
      && src.indexOf("://") === -1
      && src.indexOf("www.") === -1
      && src.indexOf("@") === -1
      && src.indexOf("  \n") === -1) {
      tokens.push({ type: "text", raw: src, text: src });
      return tokens;
    }
    const savedParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedParen && src.includes(")");
    try {
      return this.inlineTokensMasked(src, tokens);
    } finally {
      this.state.linkParenPossible = savedParen;
    }
  }

  // Mask `*`/`_`/`~` delimiters inside code spans, escapes and links so the
  // emphasis/del closers are searched on the masked copy.
  maskEmStrong(src) {
    let masked = src;
    if (this.tokens.links && src.includes("[")) {
      const searchRe = this.tokenizer.rules.inline.reflinkSearch;
      const replaceRef = (ref) => {
        const open = ref.lastIndexOf("[");
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(ref.slice(open + 1, -1)))) return ref;
        if (open > 1 && ref.charAt(0) !== "!") {
          const inner = ref.slice(1, open - 1);
          if (this.linkInText(inner)) {
            return "[" + inner.replace(searchRe, replaceRef) + "][" + "a".repeat(ref.length - open - 2) + "]";
          }
        }
        return "[" + "a".repeat(ref.length - 2) + "]";
      };
      masked = masked.replace(searchRe, replaceRef);
    }
    masked = masked.replace(
      this.tokenizer.rules.inline.anyPunctuationOutsideCode,
      (match, backticks, offset) => offset
        ? "+".repeat(match.length)
        : backticks
          ? backticks + match.slice(backticks.length, -backticks.length).replace(/`/g, "+") + backticks
          : match,
    );
    masked = masked.replace(
      this.tokenizer.rules.inline.blockSkip,
      (match, groupA, groupEmpty) => {
        const offset = groupEmpty ? groupEmpty.length : 0;
        return match.slice(0, offset) + "[" + "a".repeat(match.length - offset - 2) + "]";
      },
    );
    return masked;
  }

  inlineTokensMasked(src, tokens) {
    const needsMask = src.includes("*") || src.includes("_") || src.includes("~");
    const masked = needsMask ? this.maskEmStrong(src) : src;
    pushMask(this.tokenizer, masked);
    try {
      return this.inlineTokensLoop(src, masked, tokens);
    } finally {
      popMask(this.tokenizer);
    }
  }

  inlineTokensLoop(src, masked, tokens) {
    let wasText = false;
    let prevChar = "";
    let guard = Infinity;
    for (; src;) {
      if (src.length < guard) guard = src.length;
      else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      if (!wasText) prevChar = "";
      wasText = false;
      let token;
      // First-character dispatch: each inline token type starts with a
      // distinct character (or small set), so only the matching tokenizers
      // are tried at each position.
      const c0 = src.charCodeAt(0);
      if (c0 === 92) { // backslash: escape, else hard break
        if (token = this.tokenizer.escape(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c0 === 60) { // <: tag, else autolink
        if (token = this.tokenizer.tag(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.autolink(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c0 === 91 || c0 === 33) { // [ or !: link, else reflink
        if (token = this.tokenizer.link(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
        if (token = this.tokenizer.reflink(src, this.tokens.links)) {
          src = src.substring(token.raw.length);
          const prev = tokens.at(-1);
          if (token.type === "text" && prev?.type === "text") {
            prev.raw += token.raw;
            prev.text += token.text;
          } else tokens.push(token);
          continue;
        }
      } else if (c0 === 42 || c0 === 95) { // * or _: emphasis
        if (token = this.tokenizer.emStrong(src, masked, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c0 === 96) { // backtick: code span
        if (token = this.tokenizer.codespan(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c0 === 126) { // ~: strikethrough
        if (token = this.tokenizer.del(src, masked, prevChar)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (c0 === 32) { // space: hard break (two spaces + newline)
        if (token = this.tokenizer.br(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      } else if (!this.state.inLink && this.maybeUrl(src)) {
        if (token = this.tokenizer.url(src)) {
          src = src.substring(token.raw.length);
          tokens.push(token);
          continue;
        }
      }
      if (token = this.tokenizer.inlineText(src)) {
        src = src.substring(token.raw.length);
        if (token.raw.slice(-1) !== "_") prevChar = token.raw.slice(-1);
        wasText = true;
        const prev = tokens.at(-1);
        if (prev?.type === "text") {
          prev.raw += token.raw;
          prev.text += token.text;
        } else tokens.push(token);
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    return tokens;
  }

  // Cheap necessary condition for the extended-autolink regex: the string
  // must start with a word-ish character and contain one of the url/email
  // markers the regex can match.
  maybeUrl(src) {
    const c0 = src.charCodeAt(0);
    const wordish = (c0 >= 48 && c0 <= 57) || (c0 >= 65 && c0 <= 90)
      || (c0 >= 97 && c0 <= 122) || c0 === 46 || c0 === 95 || c0 === 43 || c0 === 45;
    if (!wordish) return false;
    if (src.startsWith("www.")) return true;
    const proto = src.indexOf("://");
    if (proto >= 2 && proto <= 32) return true;
    if (src.indexOf("@") !== -1) return true;
    return false;
  }

  infiniteLoopError(byte) {
    const msg = "Infinite loop on byte: " + byte;
    throw new Error(msg);
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

class Renderer {
  constructor() {
    this.parser = null;
  }

  space() {
    return "";
  }

  code({ text, lang, escaped }) {
    const langName = (lang || "").match(RX.notSpaceStart)?.[0];
    const body = text ? text.replace(RX.endingNewline, "") + "\n" : "";
    if (langName) {
      return '<pre><code class="language-' + escapeHtml(langName) + '">' + (escaped ? body : escapeHtml(body, true)) + "</code></pre>\n";
    }
    return "<pre><code>" + (escaped ? body : escapeHtml(body, true)) + "</code></pre>\n";
  }

  blockquote({ tokens }) {
    return "<blockquote>\n" + this.parser.parse(tokens) + "</blockquote>\n";
  }

  html({ text }) {
    return text;
  }

  def() {
    return "";
  }

  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }

  hr() {
    return "<hr>\n";
  }

  list({ ordered, start, items }) {
    let body = "";
    for (const item of items) body += this.listitem(item);
    const tag = ordered ? "ol" : "ul";
    const startAttr = ordered && start !== 1 ? ' start="' + start + '"' : "";
    return "<" + tag + startAttr + ">\n" + body + "</" + tag + ">\n";
  }

  listitem(item) {
    return `<li>${this.parser.parse(item.tokens)}</li>\n`;
  }

  checkbox({ checked }) {
    return "<input " + (checked ? 'checked="" ' : "") + 'disabled="" type="checkbox"> ';
  }

  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }

  table({ header, rows }) {
    let head = "";
    for (const cell of header) head += this.tablecell(cell);
    head = this.tablerow({ text: head });
    let body = "";
    for (const row of rows) {
      let cells = "";
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return "<table>\n<thead>\n" + head + "</thead>\n" + body + "</table>\n";
  }

  tablerow({ text }) {
    return "<tr>\n" + text + "</tr>\n";
  }

  tablecell(cell) {
    const inner = this.parser.parseInline(cell.tokens);
    const tag = cell.header ? "th" : "td";
    return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }

  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`;
  }

  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`;
  }

  codespan({ text }) {
    return `<code>${escapeHtml(text, true)}</code>`;
  }

  br() {
    return "<br>";
  }

  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`;
  }

  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? escapeHtml(text, true) : this.parser.parseInline(tokens);
    const encoded = encodeHref(href);
    if (encoded === null) return inner;
    const safeHref = escapeHtml(encoded, autolink);
    let out = '<a href="' + safeHref + '"';
    if (title) out += ' title="' + escapeHtml(title) + '"';
    return out + ">" + inner + "</a>";
  }

  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const encoded = encodeHref(href);
    if (encoded === null) return escapeHtml(text);
    const safeHref = escapeHtml(encoded);
    let out = `<img src="${safeHref}" alt="${escapeHtml(text)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return out + ">";
  }

  text(token) {
    if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ("escaped" in token && token.escaped) return token.text;
    return escapeHtml(token.text);
  }
}

// Plain-text renderer (used for image alt text).
class TextRenderer {
  constructor() {
    this.parser = null;
  }

  strong({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  em({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  codespan({ text }) {
    return text;
  }

  del({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  html({ text }) {
    return text;
  }

  text({ text }) {
    return text;
  }

  link({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  image({ text, tokens }) {
    return tokens ? this.parser.parseInline(tokens, this) : text;
  }

  br() {
    return "";
  }

  checkbox({ raw }) {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }

  parse(tokens) {
    let out = "";
    for (const token of tokens) {
      switch (token.type) {
        case "space": out += this.renderer.space(token); break;
        case "hr": out += this.renderer.hr(token); break;
        case "heading": out += this.renderer.heading(token); break;
        case "code": out += this.renderer.code(token); break;
        case "table": out += this.renderer.table(token); break;
        case "blockquote": out += this.renderer.blockquote(token); break;
        case "list": out += this.renderer.list(token); break;
        case "checkbox": out += this.renderer.checkbox(token); break;
        case "html": out += this.renderer.html(token); break;
        case "def": out += this.renderer.def(token); break;
        case "paragraph": out += this.renderer.paragraph(token); break;
        case "text": out += this.renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }

  parseInline(tokens, renderer = this.renderer) {
    let out = "";
    for (const token of tokens) {
      switch (token.type) {
        case "escape": out += renderer.text(token); break;
        case "html": out += renderer.html(token); break;
        case "link": out += renderer.link(token); break;
        case "image": out += renderer.image(token); break;
        case "checkbox": out += renderer.checkbox(token); break;
        case "strong": out += renderer.strong(token); break;
        case "em": out += renderer.em(token); break;
        case "codespan": out += renderer.codespan(token); break;
        case "br": out += renderer.br(token); break;
        case "del": out += renderer.del(token); break;
        case "text": out += renderer.text(token); break;
        default: throw new Error('Token with "' + token.type + '" type was not found.');
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Parser().parse(tokens);
}
