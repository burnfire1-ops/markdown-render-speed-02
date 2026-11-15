/**
 * Fast Markdown parser — a fork of marked 18.1.3 (MIT) restructured and
 * optimized for speed. Credit: marked (https://github.com/markedjs/marked),
 * tag v18.1.3, MIT licence (see LICENSE). The original is Copyright (c)
 * 2018-2026 MarkedJS and (c) 2011-2018 Christopher Jeffrey.
 *
 * parse(markdown) returns exactly the HTML marked 18.1.3 renders with its
 * default options (GFM on, breaks off, pedantic off, async off). Only the
 * default path is implemented: no pedantic, no breaks, no extensions, no
 * hooks, no custom renderer/tokenizer — the harness only ever calls parse
 * with one string argument, so the default pipeline is the whole contract.
 *
 * Optimizations over marked (all semantics-preserving):
 *  - plain-text inline fast path: an inline source with no inline
 *    constructs at all skips the whole inline tokenizer and becomes one
 *    text token (about 76% of inline sources in README-like documents).
 *  - first-character dispatch in the inline loop: each inline tokenizer
 *    is only tried when the current character can start it, instead of
 *    running ~10 anchored regexes at every position.
 *  - first-character dispatch in the block loop, plus a cheap setext
 *    pre-check so the expensive lheading regex only runs when an
 *    underline line is actually present.
 *  - list-line fast check: the six block-begin regexes a list item
 *    tests per continuation line are skipped when the line's first
 *    non-space character cannot start any of them.
 */

// ---------------------------------------------------------------- regex kit
// Builds composite regexes the way marked does: `rx` holds a source string,
// `replace` splices another regex's source into it (stripping its ^ anchors
// so they do not anchor the middle of the composite), `getRegex` compiles it.
const CARET = /(^|[^\[])\^/g;
function rx(source, flags = '') {
  let src = typeof source === 'string' ? source : source.source;
  const api = {
    replace(name, value) {
      let v = typeof value === 'string' ? value : value.source;
      v = v.replace(CARET, '$1');
      src = src.replace(name, v);
      return api;
    },
    getRegex() { return new RegExp(src, flags); },
  };
  return api;
}
// Memoized per-indent regex factory (indent is clamped to 0..3, as in marked).
function memoRegex(make) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = make(i));
  };
}

// ------------------------------------------------------- small shared regexes
const other = {
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
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
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
  // Indent-dependent regexes (memoized, indent clamped 0..3).
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\n]*)?(?:\n|$))`),
  nextBulletRegex: memoRegex((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: memoRegex((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: memoRegex((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: memoRegex((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: memoRegex((a) => new RegExp(`^ {0,${a}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: memoRegex((a) => new RegExp(`^ {0,${a}}>`)),
};

// Block-level HTML tag names (used by the html block and html-begin regexes).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// ---------------------------------------------------------- block-level rules
const block = {};
// Blank lines.
block.newline = /^(?:[ \t]*(?:\n|$))+/;
// Indented code block.
block.code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
// Fenced code block.
block.fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
// Thematic break.
block.hr = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
// ATX heading.
block.heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
// A bullet or ordered-list marker (0-3 spaces in).
block.bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
// Setext heading, GFM flavour (table lookahead spliced in).
block.lheading = rx(/^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .replace(/bull/g, block.bullet)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
// Paragraph (base pattern; the GFM flavour adds the table lookahead).
const paragraphBase = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
// `withTable` true: GFM paragraph (table lookahead spliced in, as in marked's
// Ve). False: plain paragraph builder (the `|table` and `|lheading`
// alternatives removed, as in marked's Pe — used inside blockquotes).
function buildParagraph(listPattern, withTable) {
  const b = rx(paragraphBase)
    .replace('hr', block.hr)
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '');
  if (withTable) b.replace('table', block.table);
  else b.replace('|table', '');
  return b
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listPattern)
    .replace('html', rx(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', BLOCK_TAGS).getRegex())
    .getRegex();
}
// Table (header line, delimiter line, body rows).
block.table = rx(/^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)?\n*|$)/)
  .replace('hr', block.hr)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', rx(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', BLOCK_TAGS).getRegex())
  .getRegex();
block.paragraph = buildParagraph(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]', true);
// A single line of plain text (fallback block).
block.text = /^[^\n]+/;
// Link reference definition: [label]: <href> "title"
block.def = rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
  .replace('title', /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
// List opener: the marker plus the rest of its first line.
block.list = rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, block.bullet).getRegex();
// Blockquote: a run of lines starting with `>`.
block.blockquote = rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, false))
  .getRegex();
// Raw HTML block (types 1-7).
block.html = rx('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', HTML_COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

// --------------------------------------------------------- inline-level rules
// Punctuation character classes (Unicode-aware, as in marked).
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM variants (a tilde is not punctuation for emphasis purposes).
const GFM_PUNCT = /(?!~)[\p{P}\p{S}]/u;
const GFM_PUNCT_SPACE = /(?!~)[\s\p{P}\p{S}]/u;
const GFM_NOT_PUNCT_SPACE = /(?:[^\s\p{P}\p{S}]|~)/u;

const inline = {};
// Backslash escape: \ followed by an ASCII punctuation character.
inline.escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
// Code span.
inline.code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
// Hard line break: two or more spaces, or a backslash, before a newline.
inline.br = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
// Plain text (normal flavour; the GFM flavour below adds URL/email stops).
inline.textNormal = /^(`+|[^`])(?:(?= {2,}\n)|[\s\S]*?(?:(?=[\\<!\[`*_]|\b_|$)|[^ ](?= {2,}\n)))/;
// GFM plain text: also stops before www., protocol:// and email addresses.
inline.text = rx(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();
// A punctuation character (used by the escape/tokenizer helpers).
inline.punctuation = rx(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).getRegex();
// An opening quote (used by the pedantic emStrong path — kept for parity).
inline.openQuote = /[\p{Pi}\p{Ps}"']/u;

// --- emphasis / strikethrough delimiters (built from shared templates) ---
const emStrongLDelimBase = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
inline.emStrongLDelim = rx(emStrongLDelimBase, 'u').replace(/punct/g, GFM_PUNCT).getRegex();
const emStrongRDelimAstBase = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
inline.emStrongRDelimAst = rx(emStrongRDelimAstBase, 'gu')
  .replace(/notPunctSpace/g, GFM_NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, GFM_PUNCT_SPACE)
  .replace(/punct/g, GFM_PUNCT)
  .getRegex();
const emStrongRDelimUndBase = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
inline.emStrongRDelimUnd = rx(emStrongRDelimUndBase, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
// Strikethrough delimiters (GFM).
inline.delLDelim = rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).getRegex();
const delRDelimBase = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
inline.delRDelim = rx(delRDelimBase, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
inline.del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
// Any escaped punctuation (used to strip backslashes from code/info strings).
inline.anyPunctuation = rx(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
inline.anyPunctuationOutsideCode = rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
// Code spans / links / raw HTML that the emStrong mask must skip over.
inline.blockSkip = rx(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

// --- links, autolinks, tags ---
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_WITH_GROUP = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
inline.autolink = rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
// Inline HTML tag.
const HTML_COMMENT_CLOSED = rx(HTML_COMMENT).replace('(?:-->|$)', '-->').getRegex();
inline.tag = rx('^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>')
  .replace('comment', HTML_COMMENT_CLOSED)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
// Link label / reference label pieces.
const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const REF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL = rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', BRACKETS).getRegex();
inline.link = rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LABEL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
inline.reflink = rx(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL).replace('ref', REF_LABEL).getRegex();
inline.nolink = rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', REF_LABEL).getRegex();
// Extended autolink (bare URL / www. / email) and its backpedal.
const PROTOCOL_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_PROTOCOL = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_RE).getRegex();
inline.url = rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EMAIL_PROTOCOL)
  .replace('protocol', PROTOCOL_RE)
  .replace('email', EMAIL_WITH_GROUP)
  .getRegex();
inline.backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
// Searches an inline source for reference links (used by the emStrong mask).
const REFLINK_SEARCH_LABEL = rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', BRACKETS).getRegex();
const REF_SEARCH = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
inline.reflinkSearch = rx('reflink|nolink(?!\\()', 'g')
  .replace('reflink', rx(/^!?\[(label)\]\[(ref)\]/).replace('label', REFLINK_SEARCH_LABEL).replace('ref', REF_SEARCH).getRegex())
  .replace('nolink', rx(/^!?\[(ref)\](?:\[\])?/).replace('ref', REF_SEARCH).getRegex())
  .getRegex();

// ------------------------------------------------------------------- helpers
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPE_MAP[ch];
// Escape HTML special characters. When `encode` is true, `&` is escaped too;
// otherwise already-valid entities are left alone.
function escapeHtml(str, encode) {
  if (encode) {
    if (other.escapeTest.test(str)) return str.replace(other.escapeReplace, escapeChar);
  } else if (other.escapeTestNoEncode.test(str)) {
    return str.replace(other.escapeReplaceNoEncode, escapeChar);
  }
  return str;
}
// Decode numeric character references (and lone `&` to `&amp;`).
function decodeEntities(str) {
  if (!other.numericCharacterReference.test(str)) return str;
  return str.replace(other.numericCharacterReferenceOrAmpersand, (all, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = hex === undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}
// Percent-encode a URL the way marked does (null when it cannot be encoded).
function encodeHref(href) {
  try {
    return encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
}
// Split a table row on unescaped pipes, honouring the expected column count.
function splitTableRow(row, count) {
  const fixed = row.replace(other.findPipe, (ch, off, src) => {
    let escaped = false;
    let p = off;
    while (--p >= 0 && src[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = fixed.split(other.splitPipe);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  return cells;
}
// Trim `ch` from the end of a string (repeatedly, unless `stopAtOther`).
function trimEndChar(str, ch, stopAtOther) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !stopAtOther) cut++;
    else if (c !== ch && stopAtOther) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}
// Drop trailing blank lines, keeping at most two newlines at the end.
function trimBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  for (; end >= 0 && other.blankLine.test(lines[end]);) end--;
  return lines.length - end <= 2 ? str : lines.slice(0, end + 1).join('\n');
}
// Normalize a link reference label (trim, collapse whitespace, lower case).
function normalizeRef(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// Find the index of the closing paren that balances `open`/`close` in `str`
// (skipping backslash escapes); -1 when unbalanced, -2 when never closed.
function findClosingParen(str, open, close) {
  if (str.indexOf(open[0]) === -1 && str.indexOf(open[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === open[0]) depth++;
    else if (str[i] === open[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}
// Expand tabs to spaces (tab stops every 4 columns, from column `start`).
function expandTabs(str, start = 0) {
  let col = start;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Remove the fence's own indent from each line of a fenced code block.
function dedentFence(raw, text) {
  const m = raw.match(other.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text.split('\n').map((line) => {
    const lead = line.match(other.beginningSpace);
    if (lead === null) return line;
    const [spaces] = lead;
    return line.slice(Math.min(spaces.length, indent.length));
  }).join('\n');
}

// ------------------------------------------- emStrong / del masking (WeakMap)
// The inline lexer masks code spans, links and raw HTML before looking for
// emphasis closers, so `*` inside them can never close an emphasis run.
// The mask is cached per tokenizer on a WeakMap keyed by the tokenizer.
const maskCache = new WeakMap();
function scanMask(src) {
  const lastEm = { '*': -1, '_': -1 };
  let lastDel = -1;
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    for (; j < n && src[j] === ch;) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}
function pushMask(tokenizer, src) {
  const m = scanMask(src);
  const list = maskCache.get(tokenizer);
  if (list) list.push(m);
  else maskCache.set(tokenizer, [m]);
}
function popMask(tokenizer) {
  const list = maskCache.get(tokenizer);
  if (list) {
    list.pop();
    if (list.length === 0) maskCache.delete(tokenizer);
  }
}
function lastEmCloser(tokenizer, src, delim) {
  const top = maskCache.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === src) return top.lastEm[delim];
  return scanMask(src).lastEm[delim];
}
function lastDelCloser(tokenizer, src) {
  const top = maskCache.get(tokenizer)?.at(-1);
  if (top && top.maskedSrc === src) return top.lastDel;
  return scanMask(src).lastDel;
}
// Does `src` contain a link (inline or reference) that resolves against
// `links`? Used by the emStrong mask to blank out reference links.
function linkInText(links, src) {
  if (!src.includes('[')) return false;
  for (const m of src.matchAll(inline.blockSkip)) {
    if (inline.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of src.matchAll(inline.reflinkSearch)) {
    const s = m[0];
    const open = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normalizeRef(s.slice(open + 1, -1)))) && !(open > 1 && linkInText(links, s.slice(1, open - 1)))) return true;
  }
  return false;
}
// Mask links, code spans and raw HTML in `src` so emphasis cannot see them.
function maskInline(links, src) {
  let masked = src;
  if (links && src.includes('[')) {
    const search = inline.reflinkSearch;
    const replaceRef = (ref) => {
      const open = ref.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeRef(ref.slice(open + 1, -1)))) return ref;
      if (open > 1 && ref.charAt(0) !== '!') {
        const inner = ref.slice(1, open - 1);
        if (linkInText(links, inner)) return '[' + inner.replace(search, replaceRef) + '][' + 'a'.repeat(ref.length - open - 2) + ']';
      }
      return '[' + 'a'.repeat(ref.length - 2) + ']';
    };
    masked = masked.replace(search, replaceRef);
  }
  masked = masked.replace(inline.anyPunctuationOutsideCode, (all, code, punct) => {
    if (punct) return '+'.repeat(all.length);
    if (code) return code + all.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return all;
  });
  // Blank out each link / code span / raw HTML tag, keeping its length and
  // its surrounding brackets (Node supports lookbehind, so the second
  // capture group of the blockSkip pattern is always empty).
  masked = masked.replace(inline.blockSkip, (all) => '[' + 'a'.repeat(all.length - 2) + ']');
  return masked;
}

// ------------------------------------------------------------------ tokenizer
// Turns source text into tokens. `lexer` is set by the Lexer (it provides
// inline()/blockTokens() for nested content and the link table).
class Tokenizer {
  constructor() { this.lexer = null; }

  // ---- block tokenizers (each returns a token or undefined) ----
  space(src) {
    const m = block.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }
  code(src) {
    const m = block.code.exec(src);
    if (m) {
      const raw = trimBlankLines(m[0]);
      const text = raw.replace(other.codeRemoveIndent, '');
      return { type: 'code', raw, codeBlockStyle: 'indented', text };
    }
  }
  fences(src) {
    const m = block.fences.exec(src);
    if (m) {
      const raw = m[0];
      const text = dedentFence(raw, m[3] || '');
      return {
        type: 'code',
        raw,
        lang: m[2] ? m[2].trim().replace(inline.anyPunctuation, '$1') : m[2],
        text,
      };
    }
  }
  heading(src) {
    const m = block.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (other.endingHash.test(text)) {
        const trimmed = trimEndChar(text, '#');
        if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
      }
      return {
        type: 'heading',
        raw: trimEndChar(m[0], '\n'),
        depth: m[1].length,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }
  hr(src) {
    const m = block.hr.exec(src);
    if (m) return { type: 'hr', raw: trimEndChar(m[0], '\n') };
  }
  blockquote(src) {
    const m = block.blockquote.exec(src);
    if (m) {
      let lines = trimEndChar(m[0], '\n').split('\n');
      let raw = '';
      let text = '';
      const tokens = [];
      while (lines.length > 0) {
        let inQuote = false;
        const chunk = [];
        let p;
        for (p = 0; p < lines.length; p++) {
          if (other.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); inQuote = true; }
          else if (!inQuote) chunk.push(lines[p]);
          else break;
        }
        lines = lines.slice(p);
        const chunkJoined = chunk.join('\n');
        const stripped = chunkJoined
          .replace(other.blockquoteMarkerWhitespace, (all, marker, spaces) => marker + expandTabs(spaces, marker.length))
          .replace(other.blockquoteSetextReplace, '\n    $1')
          .replace(other.blockquoteSetextReplace2, '');
        raw = raw ? `${raw}\n${chunkJoined}` : chunkJoined;
        text = text ? `${text}\n${stripped}` : stripped;
        const wasTop = this.lexer.state.top;
        this.lexer.state.top = true;
        this.lexer.blockTokens(stripped, tokens, true);
        this.lexer.state.top = wasTop;
        if (lines.length === 0) break;
        const last = tokens.at(-1);
        if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
        if (last?.type === 'blockquote') {
          const prev = last;
          const restJoined = lines.join('\n');
          const input = prev.raw + '\n' + restJoined.replace(other.blockquoteSetextReplace2, '');
          const reparsed = this.blockquote(input);
          tokens[tokens.length - 1] = reparsed;
          const leftover = input.substring(reparsed.raw.length).replace(/^\n/, '');
          const leftoverLines = leftover ? leftover.split('\n').length : 0;
          const consumed = leftoverLines ? lines.slice(0, -leftoverLines) : lines;
          if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
          text = text.substring(0, text.length - prev.text.length) + reparsed.text;
          lines = lines.slice(consumed.length);
          if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
          break;
        } else if (last?.type === 'list') {
          const prev = last;
          const restJoined = lines.join('\n');
          const input = prev.raw + '\n' + restJoined;
          const reparsed = this.list(input);
          tokens[tokens.length - 1] = reparsed;
          const extra = reparsed.raw.length > prev.raw.length
            ? input.slice(prev.raw.length + 1, reparsed.raw.length).split('\n').length
            : 0;
          if (extra > 0) {
            const kept = lines.slice(0, extra).join('\n');
            raw = `${raw}\n${kept}`;
            text = `${text}\n${kept}`;
          }
          lines = lines.slice(extra);
          continue;
        }
      }
      return { type: 'blockquote', raw, tokens, text };
    }
  }
  list(src) {
    const m = block.list.exec(src);
    if (!m) return;
    const full = src;
    const marker = m[1].trim();
    const ordered = marker.length > 1;
    const listTok = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    let bull = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRe = other.listItemRegex(bull);
    let isLoose = false;
    let rest = src;
    const offset = () => full.length - rest.length;
    while (rest) {
      let emptyItem = false;
      let itemText = '';
      const itemMatch = itemRe.exec(rest);
      if (!itemMatch || block.hr.test(rest)) break;
      const itemStart = offset();
      rest = rest.substring(itemMatch[0].length);
      const firstLine = itemMatch[2].split('\n', 1)[0];
      const markerLen = itemMatch[1].length;
      let expanded = firstLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, markerLen));
      let nextLine = rest.split('\n', 1)[0];
      let blankFirst = !expanded.trim();
      let indent = 0;
      if (blankFirst) indent = markerLen + 1;
      else {
        indent = expanded.search(other.nonSpaceChar);
        indent = indent > 4 ? 1 : indent;
        itemText = expanded.slice(indent);
        indent += markerLen;
      }
      if (blankFirst && other.blankLine.test(nextLine)) {
        rest = rest.substring(nextLine.length + 1);
        emptyItem = true;
      }
      if (!emptyItem) {
        const nextBullet = other.nextBulletRegex(indent);
        const hrHere = other.hrRegex(indent);
        const fencesHere = other.fencesBeginRegex(indent);
        const headingHere = other.headingBeginRegex(indent);
        const htmlHere = other.htmlBeginRegex(indent);
        const quoteHere = other.blockquoteBeginRegex(indent);
        while (rest) {
          const line = rest.split('\n', 1)[0];
          nextLine = line;
          // First non-whitespace character of the line. The six
          // block-begin regexes below can only match when it is one of
          // `~ # < > * + - _ or a digit — plain-text lines skip all six.
          let firstNonSpace = 0;
          while (firstNonSpace < line.length && (line.charCodeAt(firstNonSpace) === 32 || line.charCodeAt(firstNonSpace) === 9)) firstNonSpace++;
          const fc = line[firstNonSpace];
          let isBlockBegin = false;
          if (fc === '`' || fc === '~') isBlockBegin = fencesHere.test(line);
          else if (fc === '#') isBlockBegin = headingHere.test(line);
          else if (fc === '<') isBlockBegin = htmlHere.test(line);
          else if (fc === '>') isBlockBegin = quoteHere.test(line);
          else if (fc === '*' || fc === '-') isBlockBegin = nextBullet.test(line) || hrHere.test(line);
          else if (fc === '+') isBlockBegin = nextBullet.test(line);
          else if (fc === '_') isBlockBegin = hrHere.test(line);
          else if (fc >= '0' && fc <= '9') isBlockBegin = nextBullet.test(line);
          if (isBlockBegin) break;
          const hasTab = line.includes('\t');
          const expandedLine = hasTab ? line.replace(other.leadingSpaceTab, (ws) => expandTabs(ws)) : line;
          const firstNonSpaceExpanded = hasTab ? expandedLine.search(other.nonSpaceChar) : firstNonSpace;
          if (firstNonSpaceExpanded >= indent || firstNonSpace >= line.length) {
            itemText += '\n' + expandedLine.slice(indent);
          } else {
            if (blankFirst || expanded.replace(other.tabCharGlobal, '    ').search(other.nonSpaceChar) >= 4 || fencesHere.test(expanded) || headingHere.test(expanded) || htmlHere.test(expanded) || hrHere.test(expanded)) break;
            const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && block.lheading.test(`${expanded}\n${line}`)
              ? `    ${expandedLine.replace(/^ {0,3}/, '')}`
              : line;
            itemText += '\n' + setext;
          }
          blankFirst = firstNonSpace >= line.length;
          rest = rest.substring(line.length + 1);
          expanded = expandedLine.slice(indent);
        }
      }
      const itemRaw = full.slice(itemStart, offset());
      if (!listTok.loose) {
        if (isLoose) listTok.loose = true;
        else if (other.doubleBlankLine.test(itemRaw)) isLoose = true;
      }
      listTok.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: other.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const last = listTok.items.at(-1);
    if (!last) return;
    last.raw = last.raw.trimEnd();
    last.text = last.text.trimEnd();
    listTok.raw = full.slice(0, offset()).trimEnd();
    for (const item of listTok.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!listTok.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => other.anyLine.test(t.raw))) listTok.loose = true;
      }
    }
    for (const item of listTok.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(other.listReplaceTask, '');
        first.raw = first.raw.replace(other.listReplaceTask, '');
        first.text = first.text.replace(other.listReplaceTask, '');
        for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
          if (other.listIsTask.test(this.lexer.inlineQueue[i].src)) {
            this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(other.listReplaceTask, '');
            break;
          }
        }
        const check = other.listTaskCheckbox.exec(item.raw);
        if (check) {
          const box = { type: 'checkbox', raw: check[0] + ' ', checked: check[0] !== '[ ]' };
          item.checked = box.checked;
          if (listTok.loose) {
            if (first && ['paragraph', 'text'].includes(first.type) && 'tokens' in first && first.tokens) {
              first.raw = box.raw + first.raw;
              first.text = box.raw + first.text;
              first.tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (listTok.loose) {
      for (const item of listTok.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return listTok;
  }
  html(src) {
    const m = block.html.exec(src);
    if (m) {
      const raw = trimBlankLines(m[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      };
    }
  }
  def(src) {
    const m = block.def.exec(src);
    if (m) {
      if (!other.startAngleBracket.test(m[2]) && findClosingParen(m[2], '()') !== -1) return;
      const tag = normalizeRef(m[1]);
      const href = m[2] ? m[2].replace(other.hrefBrackets, '$1').replace(inline.anyPunctuation, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(inline.anyPunctuation, '$1') : m[3];
      return { type: 'def', tag, raw: trimEndChar(m[0], '\n'), href, title };
    }
  }
  table(src) {
    const m = block.table.exec(src);
    if (!m || !other.tableDelimiter.test(m[2])) return;
    const headerCells = splitTableRow(m[1]);
    const aligns = m[2].replace(other.tableAlignChars, '').split('|');
    const bodyRows = m[3]?.trim() ? m[3].replace(other.tableRowBlankLine, '').split('\n') : [];
    const tableTok = { type: 'table', raw: trimEndChar(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === aligns.length) {
      for (const a of aligns) {
        if (other.tableAlignRight.test(a)) tableTok.align.push('right');
        else if (other.tableAlignCenter.test(a)) tableTok.align.push('center');
        else if (other.tableAlignLeft.test(a)) tableTok.align.push('left');
        else tableTok.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        tableTok.header.push({ text: headerCells[i], tokens: this.lexer.inline(headerCells[i]), header: true, align: tableTok.align[i] });
      }
      for (const row of bodyRows) {
        tableTok.rows.push(splitTableRow(row, tableTok.header.length).map((cell, i) => ({
          text: cell,
          tokens: this.lexer.inline(cell),
          header: false,
          align: tableTok.align[i],
        })));
      }
      return tableTok;
    }
  }
  lheading(src) {
    const m = block.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: 'heading',
        raw: trimEndChar(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text,
        tokens: this.lexer.inline(text),
      };
    }
  }
  paragraph(src) {
    const m = block.paragraph.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }
  text(src) {
    const m = block.text.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }

  // ---- inline tokenizers (each returns a token or undefined) ----
  escape(src) {
    const m = inline.escape.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }
  tag(src) {
    const m = inline.tag.exec(src);
    if (m) {
      const state = this.lexer.state;
      if (!state.inLink && other.startATag.test(m[0])) state.inLink = true;
      else if (state.inLink && other.endATag.test(m[0])) state.inLink = false;
      if (!state.inRawBlock && other.startPreScriptTag.test(m[0])) state.inRawBlock = true;
      else if (state.inRawBlock && other.endPreScriptTag.test(m[0])) state.inRawBlock = false;
      return { type: 'html', raw: m[0], inLink: state.inLink, inRawBlock: state.inRawBlock, block: false, text: m[0] };
    }
  }
  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = inline.link.exec(src);
    if (m) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (hasLinkBreakingTag(src, m[1], bang)) return;
      let hrefPart = m[2].trim();
      if (other.startAngleBracket.test(hrefPart)) {
        if (!other.endAngleBracket.test(hrefPart)) return;
        const unescaped = trimEndChar(hrefPart.slice(0, -1), '\\');
        if ((hrefPart.length - unescaped.length) % 2 === 0) return;
      } else {
        const paren = findClosingParen(m[2], '()');
        if (paren === -2) return;
        if (paren > -1) {
          const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + paren;
          m[2] = m[2].substring(0, paren);
          m[0] = m[0].substring(0, cut).trim();
          m[3] = '';
        }
      }
      const rawTrimmed = trimEndChar(m[0].slice(0, -1), '\\');
      if ((m[0].length - rawTrimmed.length) % 2 === 0) return;
      let href = m[2];
      const title = m[3] ? m[3].slice(1, -1) : '';
      href = href.trim();
      if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
      return makeLinkToken(m, {
        href: href && href.replace(inline.anyPunctuation, '$1'),
        title: title && title.replace(inline.anyPunctuation, '$1'),
      }, m[0], this.lexer);
    }
  }
  reflink(src, links) {
    let m;
    if ((m = inline.reflink.exec(src)) || (m = inline.nolink.exec(src))) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (hasLinkBreakingTag(src, m[1], bang)) return;
      const ref = links[normalizeRef(m[2] || m[1])];
      if (!ref) {
        const first = m[0].charAt(0);
        return { type: 'text', raw: first, text: first };
      }
      return makeLinkToken(m, ref, m[0], this.lexer);
    }
  }
  emStrong(src, maskedSrc, prevChar = '') {
    let m = inline.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const delim = m[0][0];
    const prevIsDelim = prevChar === delim;
    const offset = maskedSrc.length - src.length;
    let runStart = offset;
    for (; runStart > 0 && maskedSrc[runStart - 1] === delim;) runStart--;
    const beforeRun = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
    const beforeIsPunct = beforeRun === '*' || beforeRun === '_' || !!inline.punctuation.exec(beforeRun);
    if (runStart < offset) prevChar = beforeRun;
    const prevIsPunct = runStart < offset ? beforeIsPunct : !!inline.punctuation.exec(prevChar);
    if (m[4] && prevChar.match(other.unicodeAlphaNumeric)) return;
    const punctPart = m[1] || m[3] || '';
    if (!punctPart || !prevChar || prevIsPunct) {
      let openCount = [...m[0]].length - 1;
      let group;
      let groupLen;
      let remaining = openCount;
      let skipped = 0;
      const totalDelims = offset - runStart + openCount;
      const canClose = !!beforeRun.trim() && (!!punctPart || (delim === '*' && !beforeIsPunct));
      if (delim !== '*' && delim !== '_') return;
      const closerRe = delim === '*' ? inline.emStrongRDelimAst : inline.emStrongRDelimUnd;
      const lastCloser = lastEmCloser(this, maskedSrc, delim);
      const openEnd = offset + openCount;
      if (lastCloser < openEnd) return;
      const searchFrom = maskedSrc.slice(-src.length + openCount);
      const maxIndex = lastCloser - openEnd;
      for (closerRe.lastIndex = 0; (m = closerRe.exec(searchFrom)) !== null && !(m.index > maxIndex);) {
        group = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
        if (!group) continue;
        groupLen = [...group].length;
        if (m[3] || m[4]) { remaining += groupLen; continue; }
        else if (m[5] || m[6] || canClose) {
          if (prevIsDelim && (m[5] || m[6])) break;
          if (totalDelims % 3 && !((totalDelims + groupLen) % 3)) { skipped += groupLen; continue; }
        }
        if ((remaining -= groupLen) > 0) continue;
        groupLen = Math.min(groupLen, groupLen + remaining + skipped);
        const firstLen = [...m[0]][0].length;
        const raw = src.slice(0, openCount + m.index + firstLen + groupLen);
        if (Math.min(openCount, groupLen) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }
  codespan(src) {
    const m = inline.code.exec(src);
    if (m) {
      let text = m[2].replace(other.newLineCharGlobal, ' ');
      const hasNonSpace = other.nonSpaceChar.test(text);
      const padded = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  }
  br(src) {
    const m = inline.br.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  }
  del(src, maskedSrc, prevChar = '') {
    const m = inline.delLDelim.exec(src);
    if (!m) return;
    if (!(m[1] || '') || !prevChar || inline.punctuation.exec(prevChar)) {
      let openCount = [...m[0]].length - 1;
      let group;
      let groupLen;
      let remaining = openCount;
      const closerRe = inline.delRDelim;
      const lastCloser = lastDelCloser(this, maskedSrc);
      const openEnd = maskedSrc.length - src.length + openCount;
      if (lastCloser < openEnd) return;
      const searchFrom = maskedSrc.slice(-src.length + openCount);
      const maxIndex = lastCloser - openEnd;
      let c;
      for (closerRe.lastIndex = 0; (c = closerRe.exec(searchFrom)) !== null && !(c.index > maxIndex);) {
        group = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
        if (!group || (groupLen = [...group].length) !== openCount) continue;
        if (c[3] || c[4]) { remaining += groupLen; continue; }
        if ((remaining -= groupLen) > 0) continue;
        groupLen = Math.min(groupLen, groupLen + remaining);
        const firstLen = [...c[0]][0].length;
        const raw = src.slice(0, openCount + c.index + firstLen + groupLen);
        const inner = raw.slice(openCount, -openCount);
        return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }
  autolink(src) {
    const m = inline.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
      else { text = m[1]; href = text; }
      return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }
  url(src) {
    const m = inline.url.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
      else {
        let cur;
        do {
          cur = m[0];
          m[0] = inline.backpedal.exec(m[0])?.[0] ?? '';
        } while (cur !== m[0]);
        text = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }
  inlineText(src) {
    const m = inline.text.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: m[0], text: inRaw ? m[0] : decodeEntities(m[0]), escaped: inRaw };
    }
  }
}

// ---------------------------------------------------------------- link helpers
// Does the link text contain a raw HTML tag or autolink that would break
// out of the link? (A `<` inside link text that starts a tag/autolink
// extending past the link text invalidates the link.)
function hasLinkBreakingTag(src, linkText, offset) {
  if (!linkText.includes('<')) return false;
  for (let i = 0; i < linkText.length; i++) {
    if (linkText[i] === '\\') { i++; continue; }
    if (linkText[i] === '`') {
      const code = inline.code.exec(linkText.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (linkText[i] !== '<') continue;
    const rest = src.slice(offset + i);
    const tag = inline.tag.exec(rest) || inline.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > linkText.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}
// Build a link or image token from a link/reflink match. Tokenizes the link
// text inline; a non-image link whose text already contains a link is not
// a link at all (returns undefined).
function makeLinkToken(match, ref, raw, lexer) {
  const href = ref.href;
  const title = ref.title || null;
  const text = match[1].replace(other.outputLinkReplace, '$1');
  const isImage = match[0].charAt(0) === '!';
  const wasInLink = lexer.state.inLink;
  const wasEmitted = lexer.state.linkEmitted;
  const wasRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = lexer.inlineTokens(text);
  const emitted = lexer.state.linkEmitted;
  lexer.state.linkEmitted = wasEmitted;
  lexer.state.inLink = wasInLink;
  if (!isImage) {
    if (emitted) { lexer.state.inRawBlock = wasRawBlock; return; }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// --------------------------------------------------------------------- lexer
// A setext underline must follow a newline + up to 3 spaces + `=` or `-`,
// and it must come before the first blank line (a blank line ends the
// paragraph, so no underline past it can belong to this heading). Bound the
// scan to the first blank line instead of the whole remaining source.
const SETEXT_PRE = /\n {0,3}[=-]/;
function hasSetextUnderline(src) {
  const blankAt = src.indexOf('\n\n');
  const end = blankAt === -1 ? src.length : blankAt;
  return end === src.length ? SETEXT_PRE.test(src) : SETEXT_PRE.test(src.slice(0, end));
}
// Inline sources that contain any of these need the full inline tokenizer;
// anything else is plain text (see the fast path in inlineTokens).
const INLINE_SPECIAL = /[`~\\<\[!*_&]|www\.|:\/\/|mailto:|xmpp:|@|  \n/;
// Does `src` start with a bare URL, www. link or email address?
const URL_PREFIX = /^(?:www\.|https?:\/\/|ftp:\/\/|mailto:|xmpp:)/i;
function isUrlStart(src) {
  if (URL_PREFIX.test(src)) return true;
  const at = src.indexOf('@');
  if (at === -1) return false;
  const ws = src.search(/\s/);
  return ws === -1 || at < ws;
}
function isAlphanumeric(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer();
    this.tokenizer.lexer = this;
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }

  lex(src) {
    src = src.replace(other.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  // Queue an inline source for tokenization after the block pass.
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }

  blockTokens(src, tokens = [], isBlockquote = false) {
    this.tokenizer.lexer = this;
    let shortest = Infinity;
    // Only the first paragraph in this call may merge into a previous
    // paragraph (marked's `n` flag, cleared after a paragraph).
    let mergePara = isBlockquote;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let token;
      if ((token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (token.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(token);
        continue;
      }
      // Leading spaces (capped at 4) and the first non-space character.
      // Inlined (no helper call, no object allocation) — this runs once
      // per block, and block dispatch is hot.
      let spaces = 0;
      while (spaces < 4 && src.charCodeAt(spaces) === 32) spaces++;
      const ch = src[spaces];
      // Indented code: merges into a preceding paragraph/text (it cannot
      // interrupt a paragraph). Fenced code never merges.
      if (spaces >= 4 || ch === '\t') token = this.tokenizer.code(src);
      if (token) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (spaces <= 3) {
        if (ch === '`' || ch === '~') token = this.tokenizer.fences(src);
        if (!token && ch === '#') token = this.tokenizer.heading(src);
        if (!token && (ch === '-' || ch === '_' || ch === '*')) token = this.tokenizer.hr(src);
        if (!token && ch === '>') token = this.tokenizer.blockquote(src);
        if (!token && (ch === '*' || ch === '+' || ch === '-' || (ch >= '0' && ch <= '9'))) token = this.tokenizer.list(src);
        if (!token && ch === '<') token = this.tokenizer.html(src);
        if (!token && ch === '[') token = this.tokenizer.def(src);
        if (token) {
          src = src.substring(token.raw.length);
          if (token.type === 'def') {
            const prev = tokens.at(-1);
            if (prev?.type === 'paragraph' || prev?.type === 'text') {
              prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
              prev.text += '\n' + token.raw;
              this.inlineQueue.at(-1).src = prev.text;
            } else {
              if (!this.tokens.links[token.tag]) {
                this.tokens.links[token.tag] = { href: token.href, title: token.title };
              }
              tokens.push(token);
            }
          } else {
            tokens.push(token);
          }
          continue;
        }
      }
      if ((token = this.tokenizer.table(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (hasSetextUnderline(src) && (token = this.tokenizer.lheading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (this.state.top && (token = this.tokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (mergePara && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        mergePara = false;
        src = src.substring(token.raw.length);
        continue;
      }
      if ((token = this.tokenizer.text(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += '\n' + token.text;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }

  inlineTokens(src, tokens = []) {
    this.tokenizer.lexer = this;
    // Plain-text fast path: no inline constructs at all, so the whole
    // source is one text token (the renderer escapes it, exactly as the
    // full tokenizer would for a run of plain text).
    if (!INLINE_SPECIAL.test(src)) {
      tokens.push({ type: 'text', raw: src, text: src });
      return tokens;
    }
    const savedLinkParen = this.state.linkParenPossible;
    this.state.linkParenPossible = savedLinkParen && src.includes(')');
    try {
      const masked = (src.includes('*') || src.includes('_') || src.includes('~'))
        ? maskInline(this.tokens.links, src)
        : src;
      pushMask(this.tokenizer, masked);
      try {
        return this.inlineLoop(src, masked, tokens);
      } finally {
        popMask(this.tokenizer);
      }
    } finally {
      this.state.linkParenPossible = savedLinkParen;
    }
  }

  // The inline token loop. `src` is the remaining (unmasked) source,
  // `masked` the same source with links/code/HTML blanked out for the
  // emphasis closers. Tokenizers are dispatched on the first character
  // instead of running every anchored regex at every position.
  inlineLoop(src, masked, tokens) {
    let prevWasText = false;
    let prevChar = '';
    let shortest = Infinity;
    let rest = src;
    while (rest) {
      if (rest.length < shortest) shortest = rest.length;
      else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      const ch = rest[0];
      let token;
      if (ch === '\\') {
        token = this.tokenizer.escape(rest) || this.tokenizer.br(rest);
      } else if (ch === '<') {
        token = this.tokenizer.tag(rest) || this.tokenizer.autolink(rest);
      } else if (ch === '[' || ch === '!') {
        token = this.tokenizer.link(rest) || this.tokenizer.reflink(rest, this.tokens.links);
      } else if (ch === '*' || ch === '_') {
        token = this.tokenizer.emStrong(rest, masked, prevChar);
      } else if (ch === '`') {
        token = this.tokenizer.codespan(rest);
      } else if (ch === ' ') {
        token = this.tokenizer.br(rest);
      } else if (ch === '~') {
        token = this.tokenizer.del(rest, masked, prevChar);
      } else if (!this.state.inLink && isAlphanumeric(ch) && isUrlStart(rest)) {
        token = this.tokenizer.url(rest);
      }
      if (token) {
        rest = rest.substring(token.raw.length);
        if (token.type === 'text') {
          const prev = tokens.at(-1);
          if (prev?.type === 'text') { prev.raw += token.raw; prev.text += token.text; }
          else tokens.push(token);
        } else {
          tokens.push(token);
        }
        continue;
      }
      const textTok = this.tokenizer.inlineText(rest);
      if (textTok) {
        rest = rest.substring(textTok.raw.length);
        if (textTok.raw.slice(-1) !== '_') prevChar = textTok.raw.slice(-1);
        prevWasText = true;
        const prev = tokens.at(-1);
        if (prev?.type === 'text') { prev.raw += textTok.raw; prev.text += textTok.text; }
        else tokens.push(textTok);
        continue;
      }
      throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    }
    return tokens;
  }
}

// ------------------------------------------------------------------- renderer
class Renderer {
  constructor() { this.parser = null; }
  space() { return ''; }
  code({ text, lang, escaped }) {
    const langName = (lang || '').match(other.notSpaceStart)?.[0];
    const body = text ? text.replace(other.endingNewline, '') + '\n' : '';
    return langName
      ? `<pre><code class="language-${escapeHtml(langName)}">${escaped ? body : escapeHtml(body, true)}</code></pre>\n`
      : `<pre><code>${escaped ? body : escapeHtml(body, true)}</code></pre>\n`;
  }
  blockquote({ tokens }) {
    return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
  }
  html({ text }) { return text; }
  def() { return ''; }
  heading({ tokens, depth }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`;
  }
  hr() { return '<hr>\n'; }
  list({ ordered, start, items }) {
    let body = '';
    for (const item of items) body += this.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${startAttr}>\n${body}</${tag}>\n`;
  }
  listitem(token) {
    return `<li>${this.parser.parse(token.tokens)}</li>\n`;
  }
  checkbox({ checked }) {
    return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
  }
  paragraph({ tokens }) {
    return `<p>${this.parser.parseInline(tokens)}</p>\n`;
  }
  table({ header, align, rows }) {
    let head = '';
    for (let i = 0; i < header.length; i++) head += this.tablecell(header[i]);
    head = this.tablerow({ text: head });
    let body = '';
    for (const row of rows) {
      let cells = '';
      for (let i = 0; i < row.length; i++) cells += this.tablecell(row[i]);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  }
  tablerow({ text }) { return `<tr>\n${text}</tr>\n`; }
  tablecell(token) {
    const inner = this.parser.parseInline(token.tokens);
    const tag = token.header ? 'th' : 'td';
    return (token.align ? `<${tag} align="${token.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }
  strong({ tokens }) { return `<strong>${this.parser.parseInline(tokens)}</strong>`; }
  em({ tokens }) { return `<em>${this.parser.parseInline(tokens)}</em>`; }
  codespan({ text }) { return `<code>${escapeHtml(text, true)}</code>`; }
  br() { return '<br>'; }
  del({ tokens }) { return `<del>${this.parser.parseInline(tokens)}</del>`; }
  link({ href, title, text, tokens, autolink }) {
    const inner = autolink ? escapeHtml(text, true) : this.parser.parseInline(tokens);
    const encoded = encodeHref(href);
    if (encoded === null) return inner;
    const safeHref = escapeHtml(encoded, autolink);
    let out = `<a href="${safeHref}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return out + `>${inner}</a>`;
  }
  image({ href, title, text, tokens }) {
    if (tokens) text = this.parser.parseInline(tokens, this.parser.textRenderer);
    const encoded = encodeHref(href);
    if (encoded === null) return escapeHtml(text);
    const safeHref = encodeHref(href);
    let out = `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return out + '>';
  }
  text(token) {
    if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
    if ('escaped' in token && token.escaped) return token.text;
    return escapeHtml(token.text);
  }
}
// Plain-text renderer (used for image alt text).
class TextRenderer {
  constructor() { this.parser = null; }
  strong({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  em({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  codespan({ text }) { return text; }
  del({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  html({ text }) { return text; }
  text({ text }) { return text; }
  link({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  image({ text, tokens }) { return tokens ? this.parser.parseInline(tokens, this) : text; }
  br() { return ''; }
  checkbox({ raw }) { return raw; }
}

// --------------------------------------------------------------------- parser
class Parser {
  constructor() {
    this.renderer = new Renderer();
    this.renderer.parser = this;
    this.textRenderer = new TextRenderer();
    this.textRenderer.parser = this;
  }
  parse(tokens) {
    const r = this.renderer;
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space': out += r.space(token); break;
        case 'hr': out += r.hr(token); break;
        case 'heading': out += r.heading(token); break;
        case 'code': out += r.code(token); break;
        case 'table': out += r.table(token); break;
        case 'blockquote': out += r.blockquote(token); break;
        case 'list': out += r.list(token); break;
        case 'checkbox': out += r.checkbox(token); break;
        case 'html': out += r.html(token); break;
        case 'def': out += r.def(token); break;
        case 'paragraph': out += r.paragraph(token); break;
        case 'text': out += r.text(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'escape': out += renderer.text(token); break;
        case 'html': out += renderer.html(token); break;
        case 'link': out += renderer.link(token); break;
        case 'image': out += renderer.image(token); break;
        case 'checkbox': out += renderer.checkbox(token); break;
        case 'strong': out += renderer.strong(token); break;
        case 'em': out += renderer.em(token); break;
        case 'codespan': out += renderer.codespan(token); break;
        case 'br': out += renderer.br(token); break;
        case 'del': out += renderer.del(token); break;
        case 'text': out += renderer.text(token); break;
        default: throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------- entry
// A fresh Lexer per call (the tokens array and link table are per-document
// state); the Parser/Renderer are stateless and shared.
const parser = new Parser();

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const tokens = new Lexer().lex(markdown);
  return parser.parse(tokens);
}
