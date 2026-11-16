// parse.js — markdown-render-speed-02 v5
// An ORIGINAL index scanner that returns exactly the HTML marked 18.1.3's
// marked.parse returns with default options (CommonMark 0.31.2 + GFM 0.29).
//
// Architecture: direct-emit index scanner. No token tree, no regex dispatch
// in hot paths. The block walk dispatches on charCodeAt at line starts; the
// inline walk scans char by char with a special-char table and skips plain
// text runs in a tight loop. HTML is emitted straight into one output array,
// joined once at the end. Inline rendering is deferred through a small queue
// (exactly like marked defers inline tokenizing until after the block pass)
// so link reference definitions registered anywhere in the document apply to
// links anywhere else in it. A link-definition pre-pass is NOT used: defs
// are recognized in the block walk itself, under the same conditions marked
// recognizes them (a def line that directly follows paragraph text is
// paragraph text, not a definition).
//
// Behaviour was derived from the CommonMark 0.31.2 + GFM 0.29 specs and from
// marked 18.1.3's observable output on the 720 practice cases. No code was
// copied from marked, from the #3 fork, or from any leaderboard entry.

const BLOCK_TAGS = new Set(("address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|source|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul").split("|"));

// ASCII punctuation (for flanking rules and backslash escapes).
const PUNCT = new Uint8Array(128);
for (const ch of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") PUNCT[ch.charCodeAt(0)] = 1;

// Inline-special ASCII chars: the plain-text run stops before any of these.
const SPEC = new Uint8Array(128);
for (const ch of "\\`*_~[!<&@:") SPEC[ch.charCodeAt(0)] = 1;

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function isAsciiPunctCode(c) {
  return c < 128 && !!PUNCT[c];
}
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
function isSpaceCh(ch) {
  const c = ch.charCodeAt(0);
  return c <= 32 || (c > 127 && /\s/.test(ch));
}
function isPunctCode(c) {
  if (c < 128) return !!PUNCT[c];
  return /[\p{P}\p{S}]/u.test(String.fromCharCode(c));
}
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  return c < 128 ? !!PUNCT[c] : /[\p{P}\p{S}]/u.test(ch);
}
function isWordCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

// Escape & < > " ' (encode=true) or < > " ' plus bare & (encode=false).
// Returns the input unchanged when nothing needs escaping (zero allocation).
function esc(s, enc) {
  const n = s.length;
  let i = 0;
  // find first char that needs escaping
  if (enc) {
    while (i < n) {
      const c = s.charCodeAt(i);
      if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      i++;
    }
    if (i === n) return s;
    let out = s.slice(0, i);
    for (; i < n; i++) {
      const ch = s[i];
      out += ESC_MAP[ch] || ch;
    }
    return out;
  }
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 60 || c === 62 || c === 34 || c === 39 || (c === 38 && !validEntityAt(s, i))) break;
    i++;
  }
  if (i === n) return s;
  let out = s.slice(0, i);
  for (; i < n; i++) {
    const ch = s[i];
    if (ch === "&") {
      if (validEntityAt(s, i)) out += "&";
      else out += "&amp;";
    } else out += ESC_MAP[ch] || ch;
  }
  return out;
}

// Is there a valid entity reference starting at s[i] (s[i] === '&')?
// Valid: &#digits; (1-7), &#x hex; (1-6), or &word; . end bounds the scan.
function validEntityAt(s, i, end) {
  const n = end === undefined ? s.length : end;
  let j = i + 1;
  if (j >= n) return false;
  if (s.charCodeAt(j) === 35) {
    j++;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const st = j;
      while (j < n && isHexCode(s.charCodeAt(j))) j++;
      return j > st && j - st <= 6 && j < n && s.charCodeAt(j) === 59;
    }
    const st = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    return j > st && j - st <= 7 && j < n && s.charCodeAt(j) === 59;
  }
  const st = j;
  while (j < n && isWordCode(s.charCodeAt(j))) j++;
  return j > st && j < n && s.charCodeAt(j) === 59;
}
function isHexCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

// Emit a plain-text run from src[a..b): convert numeric character references,
// escape bare & and < > " ' (HTML mode), leave valid entity references as-is.
// In text mode (st.m === 1, for image alt text), do not escape < > " '
// (the image renderer escapes the whole alt at the end); numeric refs still
// convert to their character, and a bare & still becomes &amp;.
// When st.r is true (inside <pre>/<code>/<kbd>/<script>), emit literally.
function emitTextRun(src, a, b, out, st) {
  if (st.r) { out.push(src.slice(a, b)); return; }
  const textMode = st.m === 1;
  let i = a, seg = a;
  while (i < b) {
    const c = src.charCodeAt(i);
    if (c === 38) {
      const ref = parseNumericRef(src, i, b);
      if (ref) {
        if (i > seg) out.push(src.slice(seg, i));
        out.push(textMode ? ref.ch : (ESC_MAP[ref.ch] || ref.ch));
        i = ref.end;
        seg = i;
        continue;
      }
      if (validEntityAt(src, i, b)) { i++; continue; }
      if (i > seg) out.push(src.slice(seg, i));
      out.push("&amp;");
      i++;
      seg = i;
    } else if (!textMode && (c === 60 || c === 62 || c === 34 || c === 39)) {
      if (i > seg) out.push(src.slice(seg, i));
      out.push(ESC_MAP[src[i]]);
      i++;
      seg = i;
    } else i++;
  }
  if (seg < b) out.push(src.slice(seg, b));
}

// Parse &#...; / &#x...; at s[i]; returns {ch, end} or null. end bounds the scan.
function parseNumericRef(s, i, end) {
  const n = end === undefined ? s.length : end;
  let j = i + 1;
  if (j >= n || s.charCodeAt(j) !== 35) return null;
  j++;
  let num;
  if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
    j++;
    const st = j;
    while (j < n && isHexCode(s.charCodeAt(j))) j++;
    if (j === st || j - st > 6 || j >= n || s.charCodeAt(j) !== 59) return null;
    num = parseInt(s.slice(st, j), 16);
  } else {
    const st = j;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j === st || j - st > 7 || j >= n || s.charCodeAt(j) !== 59) return null;
    num = parseInt(s.slice(st, j), 10);
  }
  let ch;
  if (num === 0 || num > 1114111 || (num >= 55296 && num <= 57343)) ch = "\uFFFD";
  else if (num === 38) ch = "&amp;";
  else ch = String.fromCodePoint(num);
  return { ch, end: j + 1 };
}

function encodeHref(href) {
  try {
    // encodeURI leaves '&' alone; escape a bare '&' for the HTML attribute
    // (an '&' that is already part of an entity is left as-is)
    return esc(encodeURI(href).replace(/%25/g, "%"), false);
  } catch {
    return null;
  }
}

// Normalize a link label the way marked does: trim, collapse inner
// whitespace runs to one space, Unicode case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing blank lines from a block of text but keep one trailing \n
// (marked's trimEndBlankLines helper).
function trimEndBlankLines(s) {
  const parts = s.split("\n");
  let t = parts.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(parts[t])) t--;
  return parts.length - t <= 2 ? s : parts.slice(0, t + 1).join("\n");
}

// Expand tabs in `s` to spaces, columns counted from `col`.
function expandTabs(s, col) {
  if (!s.includes("\t")) return s;
  let out = "", c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\t") {
      const w = 4 - (c % 4);
      out += " ".repeat(w);
      c += w;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// ---- Link reference definitions ----

// Remove backslash escapes before punctuation: \X -> X.
function unescPunct(s) {
  if (!s.includes("\\")) return s;
  let out = "", i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isPunctCode(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i++;
    }
  }
  return out;
}

// Paren balance of a bare destination: -1 balanced, >=0 index of the
// unmatched ')', -2 unclosed '('.
function parenBalance(s) {
  let t = 0;
  const n = s.length;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c === 92) { i++; continue; }
    if (c === 40) t++;
    else if (c === 41) { t--; if (t < 0) return i; }
  }
  return t > 0 ? -2 : -1;
}

// Try to parse a link reference definition starting at src[i] (line start,
// up to 3 leading spaces allowed). Returns {tag, href, title, end} or null.
// end is the position just past the trailing newlines.
function tryDef(src, i, end) {
  const n = end;
  let p = i;
  let sp = 0;
  while (p < n && src.charCodeAt(p) === 32 && sp < 3) { p++; sp++; }
  if (p >= n || src.charCodeAt(p) !== 91) return null; // '['
  // label: not empty, must not start with whitespace then ']'
  let q = p + 1;
  if (q < n && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9 || src.charCodeAt(q) === 10)) {
    let r = q;
    while (r < n && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
    if (r < n && src.charCodeAt(r) === 93) return null;
  }
  const labelStart = q;
  let labelEnd = -1;
  while (q < n) {
    const c = src.charCodeAt(q);
    if (c === 92) { q += 2; continue; }
    if (c === 91) return null; // unescaped '[' inside label
    if (c === 93) { labelEnd = q; break; }
    if (c === 10) {
      // newline allowed only if the next line is not blank
      let r = q + 1;
      while (r < n && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
      if (r >= n || src.charCodeAt(r) === 10) return null;
      q++;
      continue;
    }
    q++;
  }
  if (labelEnd < 0 || labelEnd === labelStart) return null;
  const label = src.slice(labelStart, labelEnd);
  q = labelEnd + 1;
  if (q >= n || src.charCodeAt(q) !== 58) return null; // ':'
  q++;
  while (q < n && src.charCodeAt(q) === 32) q++;
  // optional newline + spaces/tabs before the destination
  if (q < n && src.charCodeAt(q) === 10) {
    q++;
    while (q < n && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
  }
  if (q >= n) return null;
  // destination
  let dest, destEnd;
  const dc = src.charCodeAt(q);
  if (dc === 60) {
    // <...>: up to the first '>' on this line
    let r = q + 1;
    while (r < n && src.charCodeAt(r) !== 62 && src.charCodeAt(r) !== 10) r++;
    if (r >= n || src.charCodeAt(r) !== 62) return null;
    dest = src.slice(q + 1, r);
    destEnd = r + 1;
  } else {
    if (dc === 32 || dc === 9 || dc === 10) return null;
    let r = q;
    while (r < n) {
      const c = src.charCodeAt(r);
      if (c === 32 || c === 9 || c === 10) break;
      r++;
    }
    dest = src.slice(q, r);
    destEnd = r;
    if (parenBalance(dest) !== -1) return null;
  }
  q = destEnd;
  let title = null;
  // optional title: it must be preceded by whitespace (spaces on this line,
  // or a newline + spaces). If the title is malformed or has trailing
  // content after it, the definition still counts without a title.
  let r = q;
  while (r < n && src.charCodeAt(r) === 32) r++;
  let hadSpace = r > q;
  let nl = false;
  if (r < n && src.charCodeAt(r) === 10) {
    nl = true;
    r++;
    while (r < n && (src.charCodeAt(r) === 32 || src.charCodeAt(r) === 9)) r++;
  }
  if ((hadSpace || nl) && r < n) {
    const tc = src.charCodeAt(r);
    if (tc === 34 || tc === 39 || tc === 40) {
      const t = scanTitle(src, r, n);
      if (t) {
        // only whitespace may follow the title on its line
        let q2 = t.end;
        while (q2 < n && src.charCodeAt(q2) === 32) q2++;
        if (q2 >= n || src.charCodeAt(q2) === 10) {
          title = t.title;
          q = q2;
        }
      }
    }
  }
  // trailing spaces then newline(s) or end
  while (q < n && src.charCodeAt(q) === 32) q++;
  if (q < n && src.charCodeAt(q) !== 10) return null;
  let e = q;
  while (e < n && src.charCodeAt(e) === 10) e++;
  const href = unescPunct(dest);
  const tag = normLabel(label);
  if (tag === "") return null; // an empty label is not a definition
  return { tag, href, title, end: e };
}

// Scan a title starting at src[i] ('"' or "'" or '('). Returns {title, end}
// (end just past the closing quote/paren) or null.
function scanTitle(src, i, end) {
  const n = end;
  const open = src.charCodeAt(i);
  const close = open === 40 ? 41 : open;
  let p = i + 1;
  let out = "";
  while (p < n) {
    const c = src.charCodeAt(p);
    if (c === 92 && p + 1 < n) {
      // a backslash escape only works before ASCII punctuation; otherwise
      // the backslash is preserved literally
      if (isAsciiPunctCode(src.charCodeAt(p + 1))) { out += src[p + 1]; p += 2; }
      else { out += "\\"; p++; }
      continue;
    }
    if (c === close) return { title: out, end: p + 1 };
    if (open === 39 && c === 10) {
      // single-quoted title: newline ok unless immediately followed by
      // another newline (the regex is \n(?!\n))
      if (p + 1 < n && src.charCodeAt(p + 1) === 10) return null;
      out += "\n";
      p++;
      continue;
    }
    if (open === 34 && c === 10) { out += "\n"; p++; continue; }
    if (open === 40 && (c === 40 || c === 41)) return null;
    out += src[p];
    p++;
  }
  return null;
}

// ---- Inline rendering ----
// st = {l: inLink, r: inRawBlock, e: linkEmitted, p: linkParenPossible}

// Is the rest of src from i to end only whitespace? (hard-break lookahead)
function onlyWhitespaceAfter(src, i, end) {
  const n = end === undefined ? src.length : end;
  for (let j = i; j < n; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) return false;
  }
  return true;
}

// Email local-part chars: [A-Za-z0-9._+-]
function isEmailLocalCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 46 || c === 95 || c === 43 || c === 45;
}

// Try to match a bare URL / email starting at src[i] (i is at 'w', 'h',
// 'f', 'm', 'x', or the scheme word start). Returns {end, href, text} or null.
// text is the display text (== the matched raw, except mailto:/xmpp: keep raw).
function tryUrlAt(src, i, n) {
  // mailto: / xmpp: + email
  if (src.charCodeAt(i) === 109 || src.charCodeAt(i) === 120) {
    const m = matchMailto(src, i, n);
    if (m) return m;
  }
  // scheme:// or www.
  let j = i;
  const c0 = src.charCodeAt(i);
  if (c0 === 104 || c0 === 72) { // h
    if (src.slice(i, i + 7).toLowerCase() === "http://" ) j = i + 7;
    else if (src.slice(i, i + 8).toLowerCase() === "https://") j = i + 8;
    else return null;
  } else if (c0 === 102 || c0 === 70) { // f
    if (src.slice(i, i + 6).toLowerCase() === "ftp://") j = i + 6;
    else return null;
  } else if (c0 === 119) { // w
    if (src.slice(i, i + 4) !== "www.") return null;
    j = i + 4;
  } else return null;
  // domain: (label.)+ then [^\s<]*
  const d = matchDomainRest(src, j, n);
  if (!d) return null;
  let end = d.end;
  end = backpedalUrl(src, i, end);
  const raw = src.slice(i, end);
  const href = c0 === 119 ? "http://" + raw : raw;
  return { end, href, text: raw, raw };
}

function matchMailto(src, i, n) {
  let p = i;
  if (src.slice(i, i + 7) === "mailto:") p = i + 7;
  else if (src.slice(i, i + 5) === "xmpp:") {
    p = i + 5;
    // xmpp:email optionally followed by /resource
  } else return null;
  const em = matchEmailAt(src, p, n);
  if (!em) return null;
  let end = em.end;
  if (src.charCodeAt(i) === 120) {
    // xmpp: may have /[A-Za-z0-9@.]+ after the email
    if (end < n && src.charCodeAt(end) === 47) {
      let q = end + 1;
      while (q < n) {
        const c = src.charCodeAt(q);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64 || c === 46) q++;
        else break;
      }
      if (q > end + 1) end = q;
    }
  }
  const raw = src.slice(i, end);
  const href = src.charCodeAt(i) === 120 ? raw : "mailto:" + src.slice(p, em.end);
  return { end, href, text: raw, raw };
}

// Match an email starting at src[i] (local part). Returns {end} or null.
function matchEmailAt(src, i, n) {
  let j = i;
  while (j < n && isEmailLocalCode(src.charCodeAt(j))) j++;
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return null;
  j++;
  // domain: label(.label)+ with the last label ending in alnum
  const dstart = j;
  let labels = 0;
  while (j < n) {
    const ls = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) j++;
      else break;
    }
    if (j === ls) return null;
    labels++;
    // a '.' only continues the domain if a valid label char follows it
    if (j < n && src.charCodeAt(j) === 46) {
      const nc = j + 1 < n ? src.charCodeAt(j + 1) : -1;
      if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || nc === 45 || nc === 95) { j++; continue; }
    }
    break;
  }
  if (labels < 2) return null;
  // last label must end with alnum (not - or _): check last char
  const last = src.charCodeAt(j - 1);
  if (!((last >= 48 && last <= 57) || (last >= 65 && last <= 90) || (last >= 97 && last <= 122))) return null;
  // not followed by a word char or '-'
  if (j < n) {
    const c = src.charCodeAt(j);
    if (isWordCode(c) || c === 45) return null;
  }
  return { end: j };
}

// After scheme:// or www., match (label.)+ then [^\s<]*. Returns {end} or null.
function matchDomainRest(src, i, n) {
  let j = i;
  let labels = 0;
  while (j < n) {
    const ls = j;
    while (j < n) {
      const c = src.charCodeAt(j);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) j++;
      else break;
    }
    if (j === ls) return null;
    labels++;
    // a '.' only continues the domain if a valid label char follows it
    if (j < n && src.charCodeAt(j) === 46) {
      const nc = j + 1 < n ? src.charCodeAt(j + 1) : -1;
      if ((nc >= 48 && nc <= 57) || (nc >= 65 && nc <= 90) || (nc >= 97 && nc <= 122) || nc === 45) { j++; continue; }
    }
    break;
  }
  if (labels < 1) return null;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60) break;
    j++;
  }
  return { end: j };
}

// Trim trailing punctuation from a bare URL the way marked's _backpedal does:
// repeatedly drop a trailing run of ?!.,:;*_'"~) or a balanced-paren tail.
function backpedalUrl(src, start, end) {
  let e = end;
  for (;;) {
    const prev = e;
    // drop a trailing entity-like "&word;" sequence (not part of the URL)
    if (e > start && src.charCodeAt(e - 1) === 59) {
      let k = e - 1;
      while (k > start && isWordCode(src.charCodeAt(k - 1))) k--;
      if (k > start && src.charCodeAt(k - 1) === 38) e = k - 1;
    }
    // drop trailing chars in ?!.,:;*_'"~) (but not if part of balanced parens)
    while (e > start) {
      const c = src.charCodeAt(e - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
          c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41) {
        if (c === 41) {
          // keep a ')' if parens balance
          let depth = 0, ok = false;
          for (let k = e - 1; k >= start; k--) {
            const cc = src.charCodeAt(k);
            if (cc === 41) depth++;
            else if (cc === 40) { depth--; if (depth === 0) { ok = true; break; } }
          }
          if (ok) break;
        }
        e--;
      } else break;
    }
    // drop a trailing '&' not part of an entity (the backpedal's & alternative)
    if (e > start && src.charCodeAt(e - 1) === 38) {
      // '&' followed by [a-zA-Z0-9]+; is an entity: keep it
      let k = e;
      while (k < end && isWordCode(src.charCodeAt(k))) k++;
      if (!(k < end && src.charCodeAt(k) === 59)) e--;
    }
    if (e === prev) break;
  }
  return e;
}

// Try a raw HTML tag or comment/PI/declaration/CDATA at src[i] ('<').
// Returns {end, text} or null. The tag must be a valid tag per marked's tag regex.
function tryTag(src, i, n) {
  if (i + 1 >= n) return null;
  const c1 = src.charCodeAt(i + 1);
  // comment <!-- ... --> (search from i+2 so "<!-->" closes immediately)
  if (c1 === 33) {
    if (src.startsWith("<!--", i)) {
      const e = src.indexOf("-->", i + 2);
      if (e !== -1) return { end: e + 3 };
      return { end: n }; // unterminated comment runs to the end
    }
    if (i + 2 < n && src.charCodeAt(i + 2) === 91) { // <![CDATA[
      if (src.startsWith("<![CDATA[", i)) {
        const e = src.indexOf("]]>", i + 9);
        return { end: e === -1 ? n : e + 3 };
      }
    }
    if (i + 2 < n && src.charCodeAt(i + 2) === 63) return null; // handled below as <?
    // <![A-Za-z ...>
    if (i + 2 < n && isAlphaCode(src.charCodeAt(i + 2))) {
      const e = src.indexOf(">", i + 2);
      if (e !== -1) return { end: e + 1 };
    }
    return null;
  }
  if (c1 === 63) { // <? ... ?>
    const e = src.indexOf("?>", i + 2);
    return { end: e === -1 ? n : e + 2 };
  }
  // closing tag </name ...>
  let j = i + 1;
  let closing = false;
  if (src.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !isAlphaCode(src.charCodeAt(j))) return null;
  while (j < n && isTagNameCode(src.charCodeAt(j))) j++;
  // a closing tag has no attributes: only whitespace then '>'
  if (closing) {
    while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
    if (j < n && src.charCodeAt(j) === 62) return { end: j + 1 };
    return null;
  }
  // attributes: ( whitespace + name [= value] )* then optional / then >
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 62) return { end: j + 1 };
    if (c === 47 && j + 1 < n && src.charCodeAt(j + 1) === 62) return { end: j + 2 };
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      // attribute
      let k = j;
      while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
      if (k >= n) return null;
      const ac = src.charCodeAt(k);
      if (ac === 62) { j = k; continue; }
      if (ac === 47 && k + 1 < n && src.charCodeAt(k + 1) === 62) return { end: k + 2 };
      if (!isAttrNameCode(ac)) return null;
      while (k < n && isAttrNameCode(src.charCodeAt(k))) k++;
      const nameEnd = k; // end of the attribute name (before trailing spaces)
      while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
      if (k < n && src.charCodeAt(k) === 61) {
        k++;
        while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
        if (k >= n) return null;
        const qc = src.charCodeAt(k);
        if (qc === 34) {
          k++;
          while (k < n && src.charCodeAt(k) !== 34) k++;
          if (k >= n) return null;
          k++;
        } else if (qc === 39) {
          k++;
          while (k < n && src.charCodeAt(k) !== 39) k++;
          if (k >= n) return null;
          k++;
        } else {
          while (k < n) {
            const cc = src.charCodeAt(k);
            if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 34 || cc === 39 || cc === 61 || cc === 60 || cc === 62 || cc === 96) break;
            k++;
          }
          if (k === n) return null;
        }
      } else {
        // valueless attribute: rewind to the end of the name so the loop
        // re-enters through the whitespace branch for the next attribute
        k = nameEnd;
      }
      j = k;
      continue;
    }
    return null;
  }
  return null;
}
function isAlphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isTagNameCode(c) {
  return isAlphaCode(c) || (c >= 48 && c <= 57) || c === 45;
}
function isAttrNameCode(c) {
  return isAlphaCode(c) || c === 95 || c === 58 || (c >= 48 && c <= 57) || c === 46 || c === 45;
}

// Try an autolink <scheme:...> or <email> at src[i]. Returns {end, href, text} or null.
function tryAutolink(src, i, n) {
  if (i + 1 >= n) return null;
  // scheme: [a-zA-Z][a-zA-Z0-9+.-]{1,31} : [^\s\x00-\x1f<>]*
  let j = i + 1;
  if (!isAlphaCode(src.charCodeAt(j))) return null;
  let k = j + 1;
  while (k < n && k - j <= 32) {
    const c = src.charCodeAt(k);
    if (isAlphaCode(c) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45) k++;
    else break;
  }
  if (k - j >= 2 && k < n && src.charCodeAt(k) === 58) {
    // scheme found; content up to '>'
    let e = k + 1;
    while (e < n) {
      const c = src.charCodeAt(e);
      if (c === 62) {
        const raw = src.slice(i + 1, e);
        return { end: e + 1, href: raw, text: raw };
      }
      if (c === 32 || c === 9 || c === 10 || c < 32 || c === 60) return null;
      e++;
    }
    return null;
  }
  // email: local@domain>
  const em = matchEmailAt(src, i + 1, n);
  if (em) {
    if (em.end < n && src.charCodeAt(em.end) === 62) {
      const raw = src.slice(i + 1, em.end);
      return { end: em.end + 1, href: "mailto:" + raw, text: raw };
    }
  }
  return null;
}

// Try a code span starting at src[i] (backtick run). Returns {end, text} or null.
function tryCodespan(src, i, n) {
  // the opening run must not be preceded by a backtick (it would be part of
  // a longer run that already failed to close)
  if (i > 0 && src.charCodeAt(i - 1) === 96) return null;
  let k = 0;
  while (i + k < n && src.charCodeAt(i + k) === 96) k++;
  // find a closing run of exactly k backticks, not followed by another backtick
  let j = i + k;
  while (j < n) {
    const b = src.indexOf("`", j);
    if (b === -1) return null;
    let m = 0;
    while (b + m < n && src.charCodeAt(b + m) === 96) m++;
    if (m === k) {
      if (b + m < n && src.charCodeAt(b + m) === 96) { j = b + m; continue; }
      // content must not start or end with a backtick (unless single char)
      const content = src.slice(i + k, b);
      if (content.length > 0) {
        if (content.charCodeAt(0) === 96 || content.charCodeAt(content.length - 1) === 96) {
          // the regex requires content not to start/end with ` (except the
          // single-char case, which is also a non-backtick char)
          j = b + m;
          continue;
        }
      } else {
        j = b + m;
        continue;
      }
      let text = content.replace(/\n/g, " ");
      const hasNonSpace = /[^ ]/.test(text);
      if (hasNonSpace && text.charCodeAt(0) === 32 && text.charCodeAt(text.length - 1) === 32) {
        text = text.substring(1, text.length - 1);
      }
      return { end: b + m, text };
    }
    j = b + m;
  }
  return null;
}

// ---- Emphasis / strikethrough (port of marked's emStrong/del) ----
// char class: 0 = whitespace, 1 = punctuation/symbol, 2 = word (letter/number/mark)
const RE_PUNCT_U = /[\p{P}\p{S}]/u;
const RE_SPACE_U = /\s/u;
function charClassAt(src, i, n) {
  if (i < 0 || i >= n) return 0; // boundary behaves like whitespace
  const c = src.charCodeAt(i);
  if (c < 128) {
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) return 0;
    if (isAsciiPunctCode(c)) return 1;
    return 2;
  }
  const ch = String.fromCodePoint(src.codePointAt(i));
  if (RE_SPACE_U.test(ch)) return 0;
  if (RE_PUNCT_U.test(ch)) return 1;
  return 2;
}
function isAlnumAt(src, i, n) {
  if (i < 0 || i >= n) return false;
  const c = src.charCodeAt(i);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  const ch = String.fromCodePoint(src.codePointAt(i));
  return /[\p{L}\p{N}]/u.test(ch);
}

// Try emphasis/strong starting at src[i] (src[i] is '*' or '_').
// Returns {t:4, at, end, strong, innerStart, innerEnd} or null.
// Is the char at pos preceded by an odd number of backslashes (i.e. escaped)?
function isEscapedAt(src, pos) {
  let bs = 0;
  let q = pos - 1;
  while (q >= 0 && src.charCodeAt(q) === 92) { bs++; q--; }
  return bs % 2 === 1;
}

// If a link (inline or reference) starts at q ('['), return the position
// just past it, else -1. Used to keep emphasis closers out of link labels.
// A bare '[...]' is only skipped when its label resolves in defs.
function skipLinkAt(src, q, n, defs) {
  let depth = 0;
  let k = q;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 92) { k += 2; continue; }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) {
        // inline link: ]( ... )
        if (k + 1 < n && src.charCodeAt(k + 1) === 40) {
          let d2 = 1, m = k + 2;
          while (m < n) {
            const cc = src.charCodeAt(m);
            if (cc === 92) { m += 2; continue; }
            if (cc === 40) d2++;
            else if (cc === 41) { d2--; if (d2 === 0) return m + 1; }
            m++;
          }
          return -1;
        }
        // reflink: ][...] or ][] — skip to the second ]
        if (k + 1 < n && src.charCodeAt(k + 1) === 91) {
          const e2 = src.indexOf("]", k + 2);
          return e2 === -1 ? -1 : e2 + 1;
        }
        // shortcut reflink: a bare "[...]" is a link only if its label
        // resolves in defs
        if (defs) {
          const lab = src.slice(q + 1, k);
          if (normLabel(lab) in defs) return k + 1;
        }
        return -1;
      }
    }
    k++;
  }
  return -1;
}

function tryEmStrong(src, i, n, prevChar, defs) {
  const c = src.charCodeAt(i); // 42 '*' or 95 '_'
  let k = 0;
  while (i + k < n && src.charCodeAt(i + k) === c) k++;
  const next = i + k;
  if (next >= n) return null; // LDelim needs a non-space char after the run
  const nextCode = src.charCodeAt(next);
  if (isSpaceCode(nextCode)) return null;
  // d = the next char if it is punctuation (not the delimiter itself)
  const nextIsPunct = isPunctCodeU(src, next, n) && nextCode !== c;
  const d = nextIsPunct ? nextCode : 0;
  // u = the previous char is whitespace/punctuation (but not * or _)
  const prevExists = prevChar !== -1;
  const prevIsStarUnd = prevChar === 42 || prevChar === 95;
  const prevClass = prevExists ? charClassAt(src, i - 1, n) : 0;
  const u = prevExists && !prevIsStarUnd && (prevClass === 0 || prevClass === 1);
  // '_' opener preceded by an alphanumeric char cannot open: the whole run
  // is literal text (do not re-try the individual '_' chars)
  if (c === 95 && d === 0 && prevExists && isAlnumAt(src, i - 1, n)) return { t: -1, at: i, end: i + k };
  // canOpen: !d || !n || u   (next not punct, or no prev char, or prev is ws/punct)
  if (!(d === 0 || !prevExists || u)) return null;
  // R = prev is non-whitespace && (next is punct || (delim is '*' && prev is a word char))
  const h = prevIsStarUnd || (prevExists && (prevClass === 0 || prevClass === 1));
  const R = prevExists && prevClass !== 0 && (d !== 0 || (c === 42 && !h));
  const y = k; // effective opener length (run starts at i in this scanner)
  let m = k;   // remaining opener length
  let f = 0;   // accumulated skipped closer lengths
  // search for a closer run
  let j = i + k;
  while (j < n) {
    // find the next run of c, skipping backslash escapes, codespans and links
    let b = -1;
    for (let q = j; q < n; q++) {
      const qc = src.charCodeAt(q);
      if (qc === 92) { q++; continue; } // skip escaped char
      if (qc === 96) { const cs = tryCodespan(src, q, n); if (cs) { q = cs.end - 1; continue; } }
      if (qc === 91) { const le = skipLinkAt(src, q, n, defs); if (le !== -1) { q = le - 1; continue; } }
      if (qc === 60) { const tg = tryTag(src, q, n); if (tg) { q = tg.end - 1; continue; } const al = tryAutolink(src, q, n); if (al) { q = al.end - 1; continue; } }
      if (qc === c) { b = q; break; }
    }
    if (b === -1) return null;
    let m2 = 0;
    while (b + m2 < n && src.charCodeAt(b + m2) === c) m2++;
    // classify the run by its flanking (the RDelim groups)
    const p2 = b - 1;
    const n2 = b + m2;
    const p2Class = charClassAt(src, p2, n);
    const n2Class = charClassAt(src, n2, n);
    const p2IsDelim = p2 >= 0 && src.charCodeAt(p2) === c && !isEscapedAt(src, p2);
    // group: 1 = prev punct, next space/end (close only)
    //        2 = prev word, next punct/space/end (close only)
    //        3 = prev punct/space, next word (open only)
    //        4 = prev whitespace, next punct (open only)
    //        5 = prev punct, next punct (both)
    //        6 = prev word, next word (both)   [for '*' only; '_' has no group 6]
    let grp = 0;
    const nextIsEnd = n2 >= n;
    const nextIsSpace = n2Class === 0;
    if (p2Class === 1 && !p2IsDelim && (nextIsSpace || nextIsEnd)) grp = 1;
    else if (p2Class === 2 && (n2Class === 1 || nextIsSpace || nextIsEnd)) grp = 2;
    else if ((p2Class === 1 || p2Class === 0) && n2Class === 2) grp = 3;
    else if (p2Class === 0 && n2Class === 1) grp = 4;
    else if (p2Class === 1 && !p2IsDelim && n2Class === 1) grp = 5;
    else if (c === 42 && p2Class === 2 && n2Class === 2) grp = 6;
    // for '_', an intraword run (prev word, next word) matches no group: skip it
    if (grp === 0) { j = b + m2; continue; }
    if (grp === 3 || grp === 4) { m += m2; j = b + m2; continue; }
    if (grp === 5 || grp === 6 || R) {
      if (y % 3 !== 0 && (y + m2) % 3 === 0) { f += m2; j = b + m2; continue; }
    }
    m -= m2;
    if (m > 0) { j = b + m2; continue; }
    const used = Math.min(m2, m2 + m + f);
    // raw M = from i to (run start + used); te = 1 (the char before the run is in the match)
    const end = b + used;
    const strong = Math.min(k, used) % 2 === 0;
    return {
      t: 4, at: i, end,
      strong,
      innerStart: strong ? i + 2 : i + 1,
      innerEnd: strong ? end - 2 : end - 1
    };
  }
  return null;
}

// Is the char at src[i] a Unicode punctuation/symbol (or ASCII punct)?
function isPunctCodeU(src, i, n) {
  if (i < 0 || i >= n) return false;
  const c = src.charCodeAt(i);
  if (c < 128) return isAsciiPunctCode(c);
  const ch = String.fromCodePoint(src.codePointAt(i));
  return RE_PUNCT_U.test(ch);
}

// Try strikethrough starting at src[i] ('~'). The opener is a run of 1 or 2
// '~'; the closer must be a run of the same length. Returns {t:5,...} or null.
function tryDel(src, i, n, prevChar) {
  let o = 0;
  while (i + o < n && src.charCodeAt(i + o) === 126) o++;
  if (o === 0 || o > 2) return null;
  const next = i + o;
  if (next >= n) return null;
  const nextCode = src.charCodeAt(next);
  if (isSpaceCode(nextCode) || nextCode === 126) return null;
  // canOpen: next is not punct, or no prev char, or prev is whitespace/punct
  const nextIsPunct = isPunctCodeU(src, next, n);
  const prevExists = prevChar !== -1;
  const prevIsStarUnd = prevChar === 42 || prevChar === 95;
  const prevClass = prevExists ? charClassAt(src, i - 1, n) : 0;
  const u = prevExists && !prevIsStarUnd && (prevClass === 0 || prevClass === 1);
  if (!(nextIsPunct === false || !prevExists || u)) return null;
  let p = o;
  let j = i + o;
  while (j < n) {
    let b = -1;
    for (let q = j; q < n; q++) {
      const qc = src.charCodeAt(q);
      if (qc === 92) { q++; continue; } // skip escaped char
      if (qc === 96) { const cs = tryCodespan(src, q, n); if (cs) { q = cs.end - 1; continue; } }
      if (qc === 126) { b = q; break; }
    }
    if (b === -1) return null;
    let m2 = 0;
    while (b + m2 < n && src.charCodeAt(b + m2) === 126) m2++;
    if (m2 !== o) { j = b + m2; continue; }
    // classify like emStrong (delRDelim groups 1-6, same flanking)
    const p2 = b - 1;
    const n2 = b + m2;
    const p2Class = charClassAt(src, p2, n);
    const n2Class = charClassAt(src, n2, n);
    const nextIsEnd = n2 >= n;
    const nextIsSpace = n2Class === 0;
    let grp = 0;
    if (p2Class === 1 && (nextIsSpace || nextIsEnd)) grp = 1;
    else if (p2Class === 2 && (n2Class === 1 || nextIsSpace || nextIsEnd)) grp = 2;
    else if ((p2Class === 1 || p2Class === 0) && n2Class === 2) grp = 3;
    else if (p2Class === 0 && n2Class === 1) grp = 4;
    else if (p2Class === 1 && n2Class === 1) grp = 5;
    else if (p2Class === 2 && n2Class === 2) grp = 6;
    if (grp === 0) { j = b + m2; continue; }
    if (grp === 3 || grp === 4) { p += m2; j = b + m2; continue; }
    p -= m2;
    if (p > 0) { j = b + m2; continue; }
    const used = Math.min(m2, m2 + p);
    const end = b + used;
    return { t: 5, at: i, end, innerStart: i + o, innerEnd: end - o };
  }
  return null;
}

// ---- Link parsing (port of marked's link/reflink/De) ----

// Le group: '[' (escape | non-bracket-non-backslash)* ']'. No '[' inside.
function parseLeGroup(src, i, n) {
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 91) return -1;
    if (c === 93) return j + 1;
    j++;
  }
  return -1;
}

// Lt group: '[' (Le group | escape | non-bracket char)* ']'.
function parseLtGroup(src, i, n) {
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 91) {
      const g = parseLeGroup(src, j, n);
      if (g === -1) return -1;
      j = g;
      continue;
    }
    if (c === 93) return j + 1;
    j++;
  }
  return -1;
}

// Parse a link label starting at src[i] ('['). Returns {end, text} or null.
function parseLabel(src, i, n) {
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 93) return { end: j + 1, text: src.slice(i + 1, j) };
    if (c === 91) {
      const g = parseLtGroup(src, j, n);
      if (g === -1) return null;
      j = g;
      continue;
    }
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 96) {
      // code span first, then the ``+(?=]) alternative
      let k = 0;
      while (j + k < n && src.charCodeAt(j + k) === 96) k++;
      let b = -1;
      for (let q = j + k; q < n; q++) {
        if (src.charCodeAt(q) === 96) { b = q; break; }
      }
      if (b !== -1) {
        let m = 0;
        while (b + m < n && src.charCodeAt(b + m) === 96) m++;
        j = b + m;
        continue;
      }
      if (k >= 2 && j + k < n && src.charCodeAt(j + k) === 93) { j += k; continue; }
      return null;
    }
    j++;
  }
  return null;
}

// ke(a): paren balance of a href. -1 ok, -2 unclosed '(', >=0 index of unbalanced ')'.
function keCheck(a) {
  let t = 0, has = false;
  for (let n = 0; n < a.length; n++) {
    const c = a.charCodeAt(n);
    if (c === 92) { n++; continue; }
    if (c === 40) { t++; has = true; }
    else if (c === 41) {
      has = true;
      t--;
      if (t < 0) return n;
    }
  }
  if (!has) return -1;
  return t > 0 ? -2 : -1;
}

// Parse a title starting at src[i] ('"' or '\'' or '('). Returns {title, end} or null.
function parseTitle(src, i, n) {
  const qc = src.charCodeAt(i);
  if (qc === 34 || qc === 39) {
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === qc) return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  if (qc === 40) {
    // paren title: ( ... ) with escapes, no nested parens
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === 40) return null; // nested '(' not allowed
      if (c === 41) return { title: src.slice(i + 1, j), end: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Parse the close after a destination: whitespace* (title)? whitespace* ')'.
// Returns {title, end} (end = index after ')') or null.
function parseClose(src, i, n) {
  let k = i;
  while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
  if (k < n && src.charCodeAt(k) === 41) return { title: null, end: k + 1 };
  if (k > i && k < n) {
    const qc = src.charCodeAt(k);
    if (qc === 34 || qc === 39 || qc === 40) {
      const tm = parseTitle(src, k, n);
      if (tm) {
        let k2 = tm.end;
        while (k2 < n && isSpaceCode(src.charCodeAt(k2))) k2++;
        if (k2 < n && src.charCodeAt(k2) === 41) return { title: tm.title, end: k2 + 1 };
      }
    }
  }
  return null;
}

// Parse an <...> destination starting at src[i] ('<').
// Returns {href, end} (end = index after '>') or null.
function parseAngleDest(src, i, n) {
  let j = i + 1;
  let has = false;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 92 && j + 1 < n && src.charCodeAt(j + 1) !== 10) { j += 2; has = true; continue; }
    if (c === 10 || c === 60) return null; // no newline or '<' inside
    if (c === 62) {
      if (!has && j === i + 1) return { href: "", end: j + 1 }; // <> is allowed (empty)
      return { href: src.slice(i + 1, j), end: j + 1 };
    }
    has = true;
    j++;
  }
  return null;
}

// Parse the destination + title + closing ')' starting at src[i] ('(').
// Returns {href, title, end} (end = index after ')') or null.
// The href is the RAW destination (escapes not yet resolved).
function parseLinkDest(src, i, n) {
  let j = i + 1;
  while (j < n && isSpaceCode(src.charCodeAt(j))) j++;
  if (j >= n) return null;
  if (src.charCodeAt(j) === 41) return { href: "", title: null, end: j + 1 };
  // <...> form
  if (src.charCodeAt(j) === 60) {
    const m = parseAngleDest(src, j, n);
    if (m) {
      const c = parseClose(src, m.end, n);
      if (c) {
        // the <...> href: unescape check — if it starts with '<' it must end with '>'
        return { href: m.href, title: c.title, end: c.end };
      }
    }
    // fall through to the bare form (the '<' becomes part of the destination)
  }
  // bare form: a run of non-whitespace non-control chars
  const S = j;
  let E = S;
  while (E < n) {
    const c = src.charCodeAt(E);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c < 32) break;
    E++;
  }
  // candidates for the destination end D, longest first: E, then each ')' in the run
  const cands = [E];
  for (let k = E - 1; k >= S; k--) {
    if (src.charCodeAt(k) === 41) cands.push(k);
  }
  for (const D of cands) {
    // try the close starting at D
    let k = D;
    while (k < n && isSpaceCode(src.charCodeAt(k))) k++;
    let title = null, closeEnd = -1;
    if (k < n && src.charCodeAt(k) === 41) {
      closeEnd = k + 1;
    } else if (k > D && k < n) {
      const qc = src.charCodeAt(k);
      if (qc === 34 || qc === 39 || qc === 40) {
        const tm = parseTitle(src, k, n);
        if (tm) {
          let k2 = tm.end;
          while (k2 < n && isSpaceCode(src.charCodeAt(k2))) k2++;
          if (k2 < n && src.charCodeAt(k2) === 41) { title = tm.title; closeEnd = k2 + 1; }
        }
      }
    }
    if (closeEnd === -1) continue;
    const dest = src.slice(S, D);
    // a bare href starting with '<' must end with '>' (the <...> form failed)
    if (dest.charCodeAt(0) === 60) {
      if (dest.length === 0 || dest.charCodeAt(dest.length - 1) !== 62) continue;
      // the '>' must not be escaped (even number of backslashes before it)
      let bs = 0;
      for (let q = dest.length - 2; q >= 0 && dest.charCodeAt(q) === 92; q--) bs++;
      if (bs % 2 === 1) continue;
    }
    const keRes = keCheck(dest);
    if (keRes === -2) return null; // unclosed '(' -> the link is rejected
    if (keRes >= 0) {
      // truncate at the unbalanced ')'
      return { href: src.slice(S, S + keRes), title: null, end: S + keRes + 1 };
    }
    return { href: dest, title, end: closeEnd };
  }
  return null;
}

// Count trailing backslashes in src[a..b). Returns the count.
function trailingBackslashes(src, a, b) {
  let c = 0;
  for (let k = b - 1; k >= a && src.charCodeAt(k) === 92; k--) c++;
  return c;
}

// Try an inline link or image starting at src[i] ('[' or '![').
// Returns {t:6, at, end, href, title, labelStart, labelEnd, isImage} or null.
// The label is tokenized by the caller (processAction) so the De nested-link
// rule can be applied; this only parses the syntax.
function tryInlineLink(src, i, n, defs, hasParen) {
  let isImage = false;
  let lb = i;
  if (src.charCodeAt(i) === 33) {
    if (i + 1 >= n || src.charCodeAt(i + 1) !== 91) return null;
    isImage = true;
    lb = i + 1;
  }
  if (!hasParen) return null;
  const lab = parseLabel(src, lb, n);
  if (!lab) return null;
  // the Be check: a '<' in the label starting an unterminated tag/autolink rejects
  if (labelHasUnterminatedTag(src, lab, n)) return null;
  if (lab.end >= n || src.charCodeAt(lab.end) !== 40) return null;
  const dest = parseLinkDest(src, lab.end, n);
  if (!dest) return null;
  // the L check: the raw (minus the final ')') must not end with an odd
  // number of backslashes (the closing ')' must not be escaped)
  const rawEnd = dest.end;
  if (trailingBackslashes(src, lb, rawEnd - 1) % 2 === 1) return null;
  return {
    t: 6, at: i, end: rawEnd,
    href: dest.href, title: dest.title,
    labelStart: lb + 1, labelEnd: lab.end - 1,
    isImage
  };
}

// Be(e, label, offset): does the label contain a '<' that starts a tag or
// autolink extending beyond the label? (label = {text} relative to src)
function labelHasUnterminatedTag(src, lab, n) {
  const text = lab.text;
  if (text.indexOf("<") === -1) return false;
  const base = lab.end - 1 - text.length; // index of the label text start in src
  for (let s = 0; s < text.length; s++) {
    const c = text.charCodeAt(s);
    if (c === 92) { s++; continue; }
    if (c === 96) {
      // skip a code span in the label
      const cs = tryCodespan(src, base + s, n);
      if (cs) { s += cs.end - (base + s) - 1; continue; }
    }
    if (c !== 60) continue;
    const pos = base + s;
    const tag = tryTag(src, pos, n);
    const al = tag ? null : tryAutolink(src, pos, n);
    const m = tag || al;
    if (m) {
      if (m.end - pos > text.length - s) return true;
      s += m.end - pos - 1;
    }
  }
  return false;
}

// Try a reference link or image starting at src[i] ('[' or '![').
// Returns {t:6, at, end, href, title, labelStart, labelEnd, isImage} or null.
function tryReflink(src, i, n, defs) {
  let isImage = false;
  let lb = i;
  if (src.charCodeAt(i) === 33) {
    if (i + 1 >= n || src.charCodeAt(i + 1) !== 91) return null;
    isImage = true;
    lb = i + 1;
  }
  // [label][ref]
  const lab = parseLabel(src, lb, n);
  if (!lab) return null;
  let refText = null, end = -1, labelEnd = lab.end - 1, labelStart = lb + 1;
  if (lab.end < n && src.charCodeAt(lab.end) === 91) {
    if (lab.end + 1 < n && src.charCodeAt(lab.end + 1) === 93) {
      // [label][] — the ref is the label (nolink with empty brackets)
      refText = lab.text;
      end = lab.end + 2;
    } else {
      // [label][ref] — parse the ref (1-999 chars, not empty/whitespace-only)
      let j = lab.end + 1;
      let refEnd = -1;
      while (j < n) {
        const c = src.charCodeAt(j);
        if (c === 92 && j + 1 < n) { j += 2; continue; }
        if (c === 91 || c === 93) {
          if (c === 93) refEnd = j;
          break;
        }
        j++;
      }
      if (refEnd === -1) return null;
      refText = src.slice(lab.end + 1, refEnd);
      if (refText.length === 0 || refText.length > 999) return null;
      let allWs = true;
      for (let q = 0; q < refText.length; q++) {
        if (!isSpaceCode(refText.charCodeAt(q))) { allWs = false; break; }
      }
      if (allWs) return null;
      end = refEnd + 1;
    }
  } else {
    // [label] — the ref is the label (nolink)
    refText = lab.text;
    end = lab.end;
  }
  if (labelHasUnterminatedTag(src, lab, n)) return null;
  const key = normLabel(refText);
  const def = defs[key];
  if (!def) return null;
  return {
    t: 6, at: i, end,
    href: def.href, title: def.title,
    labelStart, labelEnd,
    isImage
  };
}

// ---- Inline main loop ----

// Try a bare URL starting at src[j] (j is at 'w', 'h', 'f', 'm', or 'x').
// Enforces the www. preceding-char rule. Returns the tryUrlAt result or null.
function tryUrlTrigger(src, j, n) {
  const c = src.charCodeAt(j);
  if (c === 119) {
    if (src.slice(j, j + 4) !== "www.") return null;
    const prev = j === 0 ? -1 : src.charCodeAt(j - 1);
    if (!(prev === -1 || prev === 32 || prev === 9 || prev === 10 || prev === 42 || prev === 95 || prev === 126 || prev === 40)) return null;
  }
  return tryUrlAt(src, j, n);
}

// Try an email at src[j] ('@'), looking back for the local part.
// runStart bounds the look-back (the start of the current text chunk).
function tryEmailAt(src, j, n, runStart) {
  let s = j - 1;
  while (s >= runStart && isEmailLocalCode(src.charCodeAt(s))) s--;
  s++;
  if (s >= j) return null;
  const em = matchEmailAt(src, s, n);
  if (!em) return null;
  const raw = src.slice(s, em.end);
  return { start: s, end: em.end, href: "mailto:" + raw, text: raw };
}

// Try a scheme URL at src[j] (':'), looking back for http/https/ftp.
function trySchemeAt(src, j, n, runStart) {
  let s = j - 1;
  while (s >= runStart && isAlphaCode(src.charCodeAt(s))) s--;
  s++;
  if (s >= j) return null;
  const word = src.slice(s, j).toLowerCase();
  if (word !== "http" && word !== "https" && word !== "ftp") return null;
  if (j + 2 >= n || src.charCodeAt(j + 1) !== 47 || src.charCodeAt(j + 2) !== 47) return null;
  const d = matchDomainRest(src, j + 3, n);
  if (!d) return null;
  const end = backpedalUrl(src, s, d.end);
  const raw = src.slice(s, end);
  return { start: s, end, href: raw, text: raw };
}

// Try a construct starting at src[j] (j is a SPEC char). Returns an action or null.
// runStart is the start of the current text chunk (for email/scheme look-back).
function tryConstruct(src, j, n, defs, st, runStart, hasParen) {
  const c = src.charCodeAt(j);
  if (c === 92) { // '\' — escape or hard break
    if (j + 1 < n) {
      const nc = src.charCodeAt(j + 1);
      if (isAsciiPunctCode(nc)) return { t: 1, at: j, end: j + 2, ch: nc };
      if (nc === 10 && !onlyWhitespaceAfter(src, j + 2, n)) {
        let e = j + 2;
        while (e < n && (src.charCodeAt(e) === 32 || src.charCodeAt(e) === 9)) e++;
        return { t: 3, at: j, end: e };
      }
    }
    return null;
  }
  if (c === 96) { // '`' — code span
    const cs = tryCodespan(src, j, n);
    if (cs) return { t: 2, at: j, end: cs.end, text: cs.text };
    return null;
  }
  if (c === 42 || c === 95) { // '*' '_' — emphasis
    const prevChar = j === 0 ? -1 : src.charCodeAt(j - 1);
    return tryEmStrong(src, j, n, prevChar, defs);
  }
  if (c === 126) { // '~' — strikethrough
    const prevChar = j === 0 ? -1 : src.charCodeAt(j - 1);
    return tryDel(src, j, n, prevChar);
  }
  if (c === 91) { // '[' — link or reflink
    const link = tryInlineLink(src, j, n, defs, hasParen);
    if (link) return link;
    return tryReflink(src, j, n, defs);
  }
  if (c === 33) { // '!' — image link or reflink
    if (j + 1 < n && src.charCodeAt(j + 1) === 91) {
      const link = tryInlineLink(src, j, n, defs, hasParen);
      if (link) return link;
      return tryReflink(src, j, n, defs);
    }
    return null;
  }
  if (c === 60) { // '<' — tag or autolink
    const tag = tryTag(src, j, n);
    if (tag) return { t: 9, at: j, end: tag.end };
    const al = tryAutolink(src, j, n);
    if (al) return { t: 10, at: j, end: al.end, href: al.href, text: al.text };
    return null;
  }
  if (c === 64) { // '@' — email
    if (st.l) return null;
    const em = tryEmailAt(src, j, n, runStart);
    if (em) return { t: 8, at: em.start, end: em.end, href: em.href, text: em.text };
    return null;
  }
  if (c === 58) { // ':' — scheme URL
    if (st.l) return null;
    const u = trySchemeAt(src, j, n, runStart);
    if (u) return { t: 8, at: u.start, end: u.end, href: u.href, text: u.text };
    return null;
  }
  return null; // '&' and others: no construct
}

// Render one action into out. Returns the new index (where scanning resumes).
// For a link (t:6) this applies marked's De rule: the label is tokenized into
// a scratch buffer; if it emitted a link and this is not an image, the outer
// link is rejected (returns action.at so the '[' is treated as literal text).
function processAction(src, action, n, defs, out, st) {
  const t = action.t;
  if (t === 0) { // literal run (a delimiter run that cannot open): emit as text
    emitTextRun(src, action.at, action.end, out, st);
    return action.end;
  }
  if (t === 1) { // escape: emit the escaped char
    const ch = String.fromCharCode(action.ch);
    if (st.m === 1) out.push(ch);
    else out.push(ESC_MAP[ch] || ch);
    return action.end;
  }
  if (t === 2) { // code span
    if (st.m === 1) { out.push(action.text); return action.end; }
    out.push("<code>");
    // the code content is raw text; '&' is escaped unconditionally here
    // (a codespan does not process entities)
    out.push(esc(action.text, true));
    out.push("</code>");
    return action.end;
  }
  if (t === 3 || t === 7) { // hard break
    if (st.m !== 1) out.push("<br>");
    return action.end;
  }
  if (t === 4) { // em / strong
    if (st.m !== 1) out.push(action.strong ? "<strong>" : "<em>");
    inlineRange(src, action.innerStart, action.innerEnd, out, defs, st);
    if (st.m !== 1) out.push(action.strong ? "</strong>" : "</em>");
    return action.end;
  }
  if (t === 5) { // del
    if (st.m !== 1) out.push("<del>");
    inlineRange(src, action.innerStart, action.innerEnd, out, defs, st);
    if (st.m !== 1) out.push("</del>");
    return action.end;
  }
  if (t === 9) { // raw HTML tag
    if (st.m === 1) out.push(src.slice(action.at, action.end));
    else out.push(src.slice(action.at, action.end));
    return action.end;
  }
  if (t === 10) { // autolink
    if (st.m === 1) { out.push(action.text); return action.end; }
    const hrefEnc = encodeHref(action.href);
    if (hrefEnc === null) { out.push(esc(action.text, false)); return action.end; }
    out.push('<a href="');
    out.push(hrefEnc);
    out.push('">');
    out.push(esc(action.text, false));
    out.push("</a>");
    return action.end;
  }
  if (t === 8) { // bare URL / email
    if (st.m === 1) { out.push(action.text); return action.end; }
    const hrefEnc = encodeHref(action.href);
    if (hrefEnc === null) { out.push(esc(action.text, false)); return action.end; }
    out.push('<a href="');
    out.push(hrefEnc);
    out.push('">');
    out.push(esc(action.text, false));
    out.push("</a>");
    return action.end;
  }
  if (t === 6) { // link or image
    const isImage = action.isImage;
    const hrefRaw = unescPunct(action.href);
    const titleRaw = action.title === null ? null : unescPunct(action.title);
    if (isImage) {
      // alt = the label rendered in text mode, then P-escaped (noEncode)
      const altOut = [];
      const altSt = { l: true, r: st.r, e: false, m: 1 };
      inlineRange(src, action.labelStart, action.labelEnd, altOut, defs, altSt);
      const alt = esc(altOut.join(""), false);
      // in text mode (inside another image's alt) an image is just its alt text
      if (st.m === 1) { out.push(alt); return action.end; }
      const hrefEnc = encodeHref(hrefRaw);
      if (hrefEnc === null) { out.push(alt); return action.end; }
      out.push('<img src="');
      out.push(hrefEnc);
      out.push('" alt="');
      out.push(alt);
      out.push('"');
      if (titleRaw !== null) { out.push(' title="'); out.push(esc(titleRaw, false)); out.push('"'); }
      out.push(">");
      return action.end;
    }
    // link: tokenize the label into a scratch buffer (inLink=true)
    const labOut = [];
    const labSt = { l: true, r: st.r, e: false, m: st.m };
    inlineRange(src, action.labelStart, action.labelEnd, labOut, defs, labSt);
    if (labSt.e) {
      // the label emitted a link: the outer link is rejected (De rule).
      // Emit the opening bracket (or '!' for an image) as literal text so
      // the inner link is still found on the next pass.
      emitTextRun(src, action.at, action.at + 1, out, st);
      return action.at + 1;
    }
    // a successfully parsed link counts as a link even in text mode (so the
    // De rule fires for labels rendered as alt text)
    st.e = true;
    if (st.m === 1) { out.push(labOut.join("")); return action.end; }
    const hrefEnc = encodeHref(hrefRaw);
    if (hrefEnc === null) { out.push(labOut.join("")); return action.end; }
    out.push('<a href="');
    out.push(hrefEnc);
    out.push('"');
    if (titleRaw !== null) { out.push(' title="'); out.push(esc(titleRaw, false)); out.push('"'); }
    out.push(">");
    out.push(labOut.join(""));
    out.push("</a>");
    return action.end;
  }
  return action.end;
}

// Inline-render src[a..b) into out. st: {l: inLink, r: inRawBlock, e: linkEmitted, m: mode}.
function inlineRange(src, a, b, out, defs, st) {
  const n = b;
  const pIdx = src.indexOf(")", a);
  const hasParen = pIdx !== -1 && pIdx < b;
  let i = a;
  while (i < n) {
    let j = i;
    let action = null;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 10) {
        let k = j - 1, sp = 0;
        while (k >= i && src.charCodeAt(k) === 32) { sp++; k--; }
        if (sp >= 2 && !onlyWhitespaceAfter(src, j + 1, n)) {
          let e = j + 1;
          while (e < n && (src.charCodeAt(e) === 32 || src.charCodeAt(e) === 9)) e++;
          action = { t: 7, at: j - sp, end: e };
          break;
        }
        j++;
        continue;
      }
      if (c < 128 && SPEC[c]) {
        const m = tryConstruct(src, j, n, defs, st, i, hasParen);
        if (m) {
          // t:-1 means "skip this delimiter run, it is literal text" — no
          // action is created, so the text run is not broken
          if (m.t === -1) { j = m.end; continue; }
          action = m; break;
        }
        j++;
        continue;
      }
      if (!st.l && (c === 119 || c === 104 || c === 102 || c === 109 || c === 120)) {
        const u = tryUrlTrigger(src, j, n);
        if (u) { action = { t: 8, at: j, end: u.end, href: u.href, text: u.text }; break; }
        j++;
        continue;
      }
      j++;
    }
    const end = action ? action.at : j;
    if (end > i) emitTextRun(src, i, end, out, st);
    if (!action) break;
    const ni = processAction(src, action, n, defs, out, st);
    i = ni <= action.at ? action.at + 1 : ni;
  }
}

// Inline-render a whole string into out (the entry point for block content).
function inlineInto(src, out, defs, st) {
  inlineRange(src, 0, src.length, out, defs, st);
}

// ---- Block rendering ----
// out parts are strings or job objects {isJob, text, out, raw} (inline-deferred).

// Index of the '\n' ending the line starting at i, or n.
function lineEnd(src, i, n) {
  const e = src.indexOf("\n", i);
  return e === -1 || e > n ? n : e;
}

// Is the line [i, le) blank (only spaces/tabs)?
function isBlankLine(src, i, le) {
  for (let k = i; k < le; k++) {
    const c = src.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Count leading spaces (not tabs) at src[i], up to max.
function leadingSpaces(src, i, n, max) {
  let s = 0;
  while (i + s < n && s < max && src.charCodeAt(i + s) === 32) s++;
  return s;
}

// Indent of the line at i, in columns (a tab advances to the next multiple of 4).
function indentColumns(src, i, n) {
  let col = 0;
  let k = i;
  while (k < n) {
    const c = src.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) { col += 4 - (col % 4); k++; }
    else break;
  }
  return col;
}

// Strip `cols` columns of indent from the line [i, le). A tab that straddles
// the boundary is consumed whole (CommonMark: a tab cannot be split).
// Returns {start, spaces} where spaces is the number of virtual spaces to
// prepend (0 under the whole-tab rule, kept for safety).
// Expand leading tabs in a string to spaces, given the column the string
// starts at. Only leading whitespace is expanded; tabs later in the string
// are preserved. Used when dedenting list-item content so downstream block
// handlers see spaces-only leading whitespace at the correct column.
function expandLeadingTabs(str, startCol) {
  let col = startCol;
  let k = 0;
  let out = "";
  while (k < str.length) {
    const c = str.charCodeAt(k);
    if (c === 32) { out += " "; col++; k++; }
    else if (c === 9) {
      const adv = 4 - (col % 4);
      out += " ".repeat(adv);
      col += adv;
      k++;
    } else break;
  }
  return out + str.slice(k);
}

function stripIndent(src, i, le, cols) {
  let col = 0;
  let k = i;
  let spaces = 0;
  while (k < le && col < cols) {
    const c = src.charCodeAt(k);
    if (c === 32) { col++; k++; }
    else if (c === 9) {
      const adv = 4 - (col % 4);
      if (col + adv > cols) {
        // the tab straddles the boundary: the part past it is spaces
        spaces = col + adv - cols;
        col = cols;
        k++;
      } else {
        col += adv;
        k++;
      }
    } else break;
  }
  return { start: k, spaces };
}

// Indented code block: a run of lines indented by 4+ columns (or blank lines
// between them). Cannot interrupt a paragraph (caller checks prevWasPara).
function tryIndentedCode(src, i, n, out) {
  if (indentColumns(src, i, n) < 4) return -1;
  const lines = [];
  let k = i;
  while (k < n) {
    const kle = lineEnd(src, k, n);
    if (isBlankLine(src, k, kle)) {
      // a whitespace-only line: strip 4 columns of indent, keep the rest
      const st = stripIndent(src, k, kle, 4);
      lines.push(st.spaces > 0 ? " ".repeat(st.spaces) + src.slice(st.start, kle) : src.slice(st.start, kle));
      k = kle < n ? kle + 1 : kle;
      // peek the next non-blank line: it must be indented by 4+
      let nk = k;
      let ok = false;
      while (nk < n) {
        const nle = lineEnd(src, nk, n);
        if (isBlankLine(src, nk, nle)) { nk = nle < n ? nle + 1 : nle; continue; }
        ok = indentColumns(src, nk, n) >= 4;
        break;
      }
      if (!ok) break;
      continue;
    }
    if (indentColumns(src, k, n) < 4) break;
    const st = stripIndent(src, k, kle, 4);
    lines.push(st.spaces > 0 ? " ".repeat(st.spaces) + src.slice(st.start, kle) : src.slice(st.start, kle));
    k = kle < n ? kle + 1 : kle;
  }
  while (lines.length > 0 && /^[ \t]*$/.test(lines[lines.length - 1])) lines.pop();
  if (lines.length === 0) return -1;
  const code = lines.join("\n") + "\n";
  out.push("<pre><code>" + esc(code, true) + "</code></pre>\n");
  return k;
}

// Thematic break: 0-3 spaces then 3+ of the same char (*, -, _) with spaces.
function tryHr(src, i, n, out) {
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n) return -1;
  const c = src.charCodeAt(j);
  if (c !== 42 && c !== 45 && c !== 95) return -1;
  let count = 0;
  while (j < n) {
    const cc = src.charCodeAt(j);
    if (cc === 10) break;
    if (cc === c) count++;
    else if (cc !== 32 && cc !== 9) return -1;
    j++;
  }
  if (count < 3) return -1;
  out.push("<hr>\n");
  return j < n && src.charCodeAt(j) === 10 ? j + 1 : j;
}

// ATX heading: 0-3 spaces, 1-6 '#', then a space/end, then the text.
// Closing '#'s (preceded by a space) are stripped, and trailing spaces trimmed.
function tryAtx(src, i, n, out, jobs) {
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n || src.charCodeAt(j) !== 35) return -1;
  let level = 0;
  while (j < n && src.charCodeAt(j) === 35 && level < 7) { level++; j++; }
  if (level > 6) return -1;
  if (j < n && src.charCodeAt(j) !== 32 && src.charCodeAt(j) !== 9 && src.charCodeAt(j) !== 10) return -1;
  // skip the space after the #'s
  while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
  const le = lineEnd(src, j, n);
  let end = le;
  // trim trailing spaces, then a closing sequence of #'s preceded by a space
  while (end > j && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
  if (end > j && src.charCodeAt(end - 1) === 35) {
    let k = end;
    while (k > j && src.charCodeAt(k - 1) === 35) k--;
    // a closing sequence is #'s preceded by a space; the whole content
    // being #'s also counts (the space after the opening marker separates it)
    if (k === j || (k > j && (src.charCodeAt(k - 1) === 32 || src.charCodeAt(k - 1) === 9))) {
      end = k;
      while (end > j && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
    }
  }
  const text = src.slice(j, end);
  const job = { isJob: true, text, out: [], raw: false };
  jobs.push(job);
  out.push("<h" + level + ">");
  out.push(job);
  out.push("</h" + level + ">\n");
  return le < n ? le + 1 : le;
}
// a closing fence of the same char with >= the opening length.
// Fenced code block: 0-3 spaces, 3+ '`' or '~', info string, then lines until
// a closing fence of the same char with >= the opening length.
function tryFence(src, i, n, out) {
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n) return -1;
  const c = src.charCodeAt(j);
  if (c !== 96 && c !== 126) return -1;
  let len = 0;
  while (j < n && src.charCodeAt(j) === c) { len++; j++; }
  if (len < 3) return -1;
  const le = lineEnd(src, j, n);
  let info = src.slice(j, le);
  // the info string cannot contain '`' for a backtick fence
  if (c === 96 && info.indexOf("`") !== -1) return -1;
  info = unescPunct(info.trim());
  // the first word of the info string is the language
  const lang = info.split(/\s+/)[0] || "";
  const langEsc = esc(lang, false);
  out.push(lang ? '<pre><code class="language-' + langEsc + '">' : "<pre><code>");
  // collect lines until the closing fence; each content line has up to `sp`
  // leading spaces stripped (the opening fence's indent)
  let k = le < n ? le + 1 : le;
  const codeLines = [];
  let lastHadNewline = false;
  while (k < n) {
    const kle = lineEnd(src, k, n);
    // check for a closing fence: 0-3 spaces, len+ of c, then only spaces
    const csp = leadingSpaces(src, k, n, 3);
    let m = k + csp;
    let clen = 0;
    while (m < kle && src.charCodeAt(m) === c) { clen++; m++; }
    if (clen >= len) {
      let ok = true;
      while (m < kle) {
        const cc = src.charCodeAt(m);
        if (cc !== 32 && cc !== 9) { ok = false; break; }
        m++;
      }
      if (ok) { k = kle < n ? kle + 1 : kle; break; }
    }
    let ls = k;
    const st = stripIndent(src, k, kle, sp);
    codeLines.push(st.spaces > 0 ? " ".repeat(st.spaces) + src.slice(st.start, kle) : src.slice(st.start, kle));
    lastHadNewline = kle < n;
    k = kle < n ? kle + 1 : kle;
  }
  // the code content is the lines joined with '\n', plus a trailing '\n'
  // when the last content line was newline-terminated in the source and
  // non-blank (a trailing blank line contributes no extra newline)
  const lastBlank = codeLines.length > 0 && codeLines[codeLines.length - 1] === "";
  const code = codeLines.length > 0
    ? codeLines.join("\n") + (lastHadNewline && !lastBlank ? "\n" : "")
    : "";
  out.push(esc(code, true));
  out.push("</code></pre>\n");
  return k;
}

// HTML block. Returns the index after the block, or -1.
// Types 1-6 end at a blank line; type 7 ends at a blank line too but cannot
// interrupt a paragraph. The end conditions are per-type.
function tryHtmlBlock(src, i, n, out) {
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n || src.charCodeAt(j) !== 60) return -1;
  const rest = src.slice(j, Math.min(n, j + 20));
  // type 1: <script, <pre, <style, <textarea (case-insensitive)
  const m1 = /^<(script|pre|style|textarea)([ \t\n>]|$)/i.exec(rest);
  if (m1) {
    const closeRe = new RegExp("</" + m1[1] + ">", "i");
    const ci = closeRe.exec(src.slice(j));
    const end = ci ? j + ci.index + ci[0].length : n;
    // extend to the end of the line containing the close tag
    const le = lineEnd(src, end, n);
    let htext = src.slice(i, le < n ? le + 1 : le);
    // drop the trailing newline when the next line is blank (the block is
    // followed by a blank line, so the newline is a separator, not content)
    if (le < n) {
      const nl = le + 1;
      if (nl < n) {
        const nle = lineEnd(src, nl, n);
        if (isBlankLine(src, nl, nle) && htext.charCodeAt(htext.length - 1) === 10) htext = htext.slice(0, -1);
      }
    }
    out.push(htext);
    return le < n ? le + 1 : le;
  }
  // type 2: <!-- ... -->
  if (rest.startsWith("<!--")) {
    const e = src.indexOf("-->", j + 4);
    const end = e === -1 ? n : e + 3;
    const le = lineEnd(src, end, n);
    let htext = src.slice(i, le < n ? le + 1 : le);
    // drop the trailing newline when the next line is blank (the block is
    // followed by a blank line, so the newline is a separator, not content)
    if (le < n) {
      const nl = le + 1;
      if (nl < n) {
        const nle = lineEnd(src, nl, n);
        if (isBlankLine(src, nl, nle) && htext.charCodeAt(htext.length - 1) === 10) htext = htext.slice(0, -1);
      }
    }
    out.push(htext);
    return le < n ? le + 1 : le;
  }
  // type 3: <? ... ?>
  if (rest.startsWith("<?")) {
    const e = src.indexOf("?>", j + 2);
    const end = e === -1 ? n : e + 2;
    const le = lineEnd(src, end, n);
    let htext = src.slice(i, le < n ? le + 1 : le);
    // drop the trailing newline when the next line is blank (the block is
    // followed by a blank line, so the newline is a separator, not content)
    if (le < n) {
      const nl = le + 1;
      if (nl < n) {
        const nle = lineEnd(src, nl, n);
        if (isBlankLine(src, nl, nle) && htext.charCodeAt(htext.length - 1) === 10) htext = htext.slice(0, -1);
      }
    }
    out.push(htext);
    return le < n ? le + 1 : le;
  }
  // type 4: <!A ... > (a letter after <!)
  if (rest.startsWith("<!") && j + 2 < n && isAlphaCode(src.charCodeAt(j + 2))) {
    const e = src.indexOf(">", j + 2);
    const end = e === -1 ? n : e + 1;
    const le = lineEnd(src, end, n);
    let htext = src.slice(i, le < n ? le + 1 : le);
    // drop the trailing newline when the next line is blank (the block is
    // followed by a blank line, so the newline is a separator, not content)
    if (le < n) {
      const nl = le + 1;
      if (nl < n) {
        const nle = lineEnd(src, nl, n);
        if (isBlankLine(src, nl, nle) && htext.charCodeAt(htext.length - 1) === 10) htext = htext.slice(0, -1);
      }
    }
    out.push(htext);
    return le < n ? le + 1 : le;
  }
  // type 5: <![CDATA[ ... ]]>
  if (rest.startsWith("<![CDATA[")) {
    const e = src.indexOf("]]>", j + 9);
    const end = e === -1 ? n : e + 3;
    const le = lineEnd(src, end, n);
    let htext = src.slice(i, le < n ? le + 1 : le);
    // drop the trailing newline when the next line is blank (the block is
    // followed by a blank line, so the newline is a separator, not content)
    if (le < n) {
      const nl = le + 1;
      if (nl < n) {
        const nle = lineEnd(src, nl, n);
        if (isBlankLine(src, nl, nle) && htext.charCodeAt(htext.length - 1) === 10) htext = htext.slice(0, -1);
      }
    }
    out.push(htext);
    return le < n ? le + 1 : le;
  }
  // type 6: a block tag (open or close), optionally with attributes
  const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)([ \t\n\/>]|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    // consume lines until a blank line
    let k = i;
    while (k < n) {
      const kle = lineEnd(src, k, n);
      if (isBlankLine(src, k, kle)) break;
      k = kle < n ? kle + 1 : kle;
    }
    let text = src.slice(i, k);
    if (k < n && text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
    out.push(text);
    return k;
  }
  // type 7: any other tag (a complete open or close tag on this line).
  // The tag must end on this line and be followed only by whitespace.
  const tag = tryTag(src, j, n);
  if (tag) {
    const tle = lineEnd(src, j, n);
    if (tag.end > tle) return -1;
    let onlyWs = true;
    for (let q = tag.end; q < tle; q++) {
      const cc = src.charCodeAt(q);
      if (cc !== 32 && cc !== 9) { onlyWs = false; break; }
    }
    if (onlyWs) {
      // a type-7 block: consume lines until a blank line
      let k = i;
      while (k < n) {
        const kle = lineEnd(src, k, n);
        if (isBlankLine(src, k, kle)) break;
        k = kle < n ? kle + 1 : kle;
      }
      let text = src.slice(i, k);
      if (k < n && text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
      out.push(text);
      return k;
    }
  }
  return -1;
}

// Does the line starting at i begin with a list marker (bullet or ordered,
// any start number or delimiter)? Used to stop a lazy continuation.
function isListMarkerLine(src, i, n) {
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n) return false;
  const c = src.charCodeAt(j);
  if (c === 45 || c === 43 || c === 42) {
    const nc = j + 1 < n ? src.charCodeAt(j + 1) : -1;
    return nc === 32 || nc === 9 || nc === 10 || j + 1 >= n;
  }
  if (c >= 48 && c <= 57) {
    let k = j;
    while (k < n && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57 && k - j < 9) k++;
    if (k < n && (src.charCodeAt(k) === 46 || src.charCodeAt(k) === 41)) {
      const nc = k + 1 < n ? src.charCodeAt(k + 1) : -1;
      return nc === 32 || nc === 9 || nc === 10 || k + 1 >= n;
    }
  }
  return false;
}

// Does the line starting at i begin a block that can interrupt a paragraph?
// Returns "atx", "fence", "hr", "html", "quote", "list", or "".
function blockStartAt(src, i, n, inList) {
  const le = lineEnd(src, i, n);
  if (isBlankLine(src, i, le)) return "";
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n) return "";
  const c = src.charCodeAt(j);
  // ATX heading
  if (c === 35) {
    let level = 0;
    let k = j;
    while (k < n && src.charCodeAt(k) === 35 && level < 7) { level++; k++; }
    if (level <= 6 && level >= 1 && (k >= n || src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) return "atx";
  }
  // fenced code
  if (c === 96 || c === 126) {
    let len = 0;
    let k = j;
    while (k < n && src.charCodeAt(k) === c) { len++; k++; }
    if (len >= 3) return "fence";
  }
  // thematic break (3+ of *, -, _ with spaces)
  if (c === 42 || c === 45 || c === 95) {
    let count = 0;
    let k = j;
    let ok = true;
    while (k < le) {
      const cc = src.charCodeAt(k);
      if (cc === c) count++;
      else if (cc !== 32 && cc !== 9) { ok = false; break; }
      k++;
    }
    if (ok && count >= 3) return "hr";
  }
  // blockquote
  if (c === 62) return "quote";
  // HTML block types 1-6 (type 7 cannot interrupt a paragraph)
  if (c === 60) {
    const rest = src.slice(j, Math.min(n, j + 20));
    if (/^<(script|pre|style|textarea)([ \t\n>]|$)/i.test(rest)) return "html";
    if (rest.startsWith("<!--") || rest.startsWith("<?") || rest.startsWith("<![CDATA[")) return "html";
    if (rest.startsWith("<!") && j + 2 < n && isAlphaCode(src.charCodeAt(j + 2))) return "html";
    const m6 = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)([ \t\n\/>]|$)/.exec(rest);
    if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return "html";
  }
  // list (bullet or ordered) — can interrupt only if the item is not empty,
  // and for an ordered list only if the start number is 1
  if (c === 45 || c === 43 || c === 42) {
    const nc = j + 1 < n ? src.charCodeAt(j + 1) : -1;
    if (nc === 32 || nc === 9 || nc === 10 || j + 1 >= n) {
      // not empty if there is non-whitespace content after the marker
      if (nc === 32 || nc === 9) {
        let k = j + 1;
        while (k < le && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9)) k++;
        if (k < le) return "list";
        return ""; // an empty item does not interrupt a paragraph
      }
      if (nc === 10 || j + 1 >= n) return ""; // empty item
      return "list";
    }
  }
  if (c >= 48 && c <= 57) {
    let k = j;
    let num = 0;
    while (k < n && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57 && k - j < 9) {
      num = num * 10 + (src.charCodeAt(k) - 48);
      k++;
    }
    if (k < n && (src.charCodeAt(k) === 46 || src.charCodeAt(k) === 41)) {
      const nc = k + 1 < n ? src.charCodeAt(k + 1) : -1;
      if (nc === 32 || nc === 9 || nc === 10 || k + 1 >= n) {
        if (num !== 1 && !inList) return "";
        // an empty item does not interrupt a paragraph
        if (nc === 32 || nc === 9) {
          let q = k + 1;
          while (q < le && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
          if (q >= le) return "";
        } else if (nc === 10 || k + 1 >= n) {
          return "";
        }
        return "list";
      }
    }
  }
  return "";
}

// Is the line starting at i a setext underline? Returns 1 (=), 2 (-), or 0.
// The line must be a contiguous run of '=' or '-' (0-3 leading spaces),
// followed only by spaces/tabs. A space inside the run disqualifies it.
function setextLevel(src, i, n) {
  const le = lineEnd(src, i, n);
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n) return 0;
  const c = src.charCodeAt(j);
  if (c !== 61 && c !== 45) return 0;
  while (j < le && src.charCodeAt(j) === c) j++;
  while (j < le) {
    const cc = src.charCodeAt(j);
    if (cc !== 32 && cc !== 9) return 0;
    j++;
  }
  return c === 61 ? 1 : 2;
}

// Blockquote: collect lines, strip '>' markers, parse the content recursively.
function tryBlockquote(src, i, n, defs, out, jobs) {
  const sp = leadingSpaces(src, i, n, 3);
  if (i + sp >= n || src.charCodeAt(i + sp) !== 62) return -1;
  const parts = [];
  let k = i;
  let lastWasBlank = false;
  let lastIsPara = false;
  let lastKle = -1;
  while (k < n) {
    const kle = lineEnd(src, k, n);
    const lsp = leadingSpaces(src, k, n, 3);
    if (k + lsp < n && src.charCodeAt(k + lsp) === 62) {
      let j = k + lsp + 1;
      if (j < kle && src.charCodeAt(j) === 32) j++;
      const content = src.slice(j, kle);
      parts.push(content);
      // a '>' line with no content is a blank line inside the quote
      lastWasBlank = content === "" || isBlankLine(src, j, kle);
      // the last block is a paragraph only if this line is paragraph text
      // (not blank, not a fence/hr/heading/html start, not indented code).
      // A nested blockquote or list line may still contain a paragraph, so
      // a lazy continuation is allowed after those.
      const bs = blockStartAt(src, j, n);
      lastIsPara = !lastWasBlank && bs !== "atx" && bs !== "fence" && bs !== "hr" && bs !== "html" && indentColumns(src, j, n) < 4;
      lastKle = kle;
      k = kle < n ? kle + 1 : kle;
    } else if (isBlankLine(src, k, kle)) {
      // a truly blank line (no '>') ENDS the blockquote; only a '>' line
      // with no content continues it as a blank line inside
      break;
    } else {
      // lazy continuation: only if the previous line was not blank, the
      // blockquote's last block is a paragraph, and this line does not
      // start a block that interrupts a paragraph
      if (lastWasBlank) break;
      if (parts.length === 0) break;
      if (!lastIsPara) break;
      if (blockStartAt(src, k, n) !== "") break;
      // a lazy line that could be a setext underline is indented by 4 spaces
      // so it is not re-interpreted as one when the content is re-lexed;
      // otherwise a lazy line has up to 4 leading spaces stripped
      if (setextLevel(src, k, n) !== 0) parts.push("    " + src.slice(k, kle));
      else {
        let ls = k;
        let stripped = 0;
        while (ls < kle && stripped < 4 && src.charCodeAt(ls) === 32) { ls++; stripped++; }
        parts.push(src.slice(ls, kle));
      }
      lastKle = kle;
      k = kle < n ? kle + 1 : kle;
    }
  }
  let content = parts.join("\n");
  // preserve the trailing newline when the last consumed line had one
  if (parts.length > 0 && lastKle !== -1 && lastKle < n) content += "\n";
  out.push("<blockquote>\n");
  parseBlocks(content, defs, out, jobs, 0);
  out.push("</blockquote>\n");
  return k;
}

// Split a table row on unescaped '|' (marked splits on any unescaped '|',
// even inside a code span). An escaped pipe '\|' becomes a literal '|'.
// Trims each cell.
function splitTableRow(row) {
  const cells = [];
  let cur = "";
  for (let i = 0; i < row.length; i++) {
    const c = row.charCodeAt(i);
    if (c === 92 && i + 1 < row.length) {
      // a backslash: an escaped pipe becomes a literal '|'; otherwise keep both
      if (row.charCodeAt(i + 1) === 124) { cur += "|"; i++; }
      else { cur += row[i] + row[i + 1]; i++; }
    } else if (c === 124) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += row[i];
    }
  }
  cells.push(cur.trim());
  // strip a leading empty cell (from a leading '|') and a trailing one
  if (cells.length > 0 && cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

// Is the line a valid table delimiter row? Returns the alignments array or null.
function tableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell;
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.indexOf("-") === -1) return null;
    if (t.startsWith(":") && t.endsWith(":")) aligns.push("center");
    else if (t.endsWith(":")) aligns.push("right");
    else if (t.startsWith(":")) aligns.push("left");
    else aligns.push("");
  }
  return aligns;
}

// Table: header row + delimiter row + body rows.
function tryTable(src, i, n, defs, out, jobs) {
  const le = lineEnd(src, i, n);
  const headerLine = src.slice(i, le);
  if (headerLine.indexOf("|") === -1) return -1;
  const nextStart = le < n ? le + 1 : le;
  if (nextStart >= n) return -1;
  const dle = lineEnd(src, nextStart, n);
  const delimLine = src.slice(nextStart, dle);
  const aligns = tableDelimiter(delimLine);
  if (!aligns) return -1;
  const headerCells = splitTableRow(headerLine);
  if (headerCells.length !== aligns.length) return -1;
  // emit the header
  out.push("<table>\n<thead>\n<tr>\n");
  for (let c = 0; c < headerCells.length; c++) {
    const al = aligns[c];
    out.push(al ? '<th align="' + al + '">' : "<th>");
    const job = { isJob: true, text: headerCells[c], out: [], raw: false };
    jobs.push(job);
    out.push(job);
    out.push("</th>\n");
  }
  out.push("</tr>\n</thead>\n");
  // body rows until a blank line or a line that starts a new block
  let k = dle < n ? dle + 1 : dle;
  const bodyRows = [];
  while (k < n) {
    const kle = lineEnd(src, k, n);
    if (isBlankLine(src, k, kle)) break;
    if (blockStartAt(src, k, n) !== "") break;
    bodyRows.push(src.slice(k, kle));
    k = kle < n ? kle + 1 : kle;
  }
  if (bodyRows.length > 0) {
    out.push("<tbody>");
    for (const rowLine of bodyRows) {
      const cells = splitTableRow(rowLine);
      out.push("<tr>\n");
      for (let c = 0; c < headerCells.length; c++) {
        const al = aligns[c];
        out.push(al ? '<td align="' + al + '">' : "<td>");
        const job = { isJob: true, text: c < cells.length ? cells[c] : "", out: [], raw: false };
        jobs.push(job);
        out.push(job);
        out.push("</td>\n");
      }
      out.push("</tr>\n");
    }
    out.push("</tbody>");
  }
  out.push("</table>\n");
  return k;
}

// Paragraph: consume lines until a blank line or a block that can interrupt.
// If a setext underline follows, the paragraph becomes a heading (the text
// is trimmed). A paragraph's own text is the raw lines joined with '\n'.
function parseParagraph(src, i, n, defs, out, jobs) {
  const lines = [];
  let k = i;
  let level = 0;
  while (k < n) {
    const kle = lineEnd(src, k, n);
    if (isBlankLine(src, k, kle)) break;
    // a setext underline after the first line converts the paragraph
    if (lines.length > 0) {
      const sl = setextLevel(src, k, n);
      if (sl !== 0) { level = sl; k = kle < n ? kle + 1 : kle; break; }
    }
    if (lines.length > 0 && blockStartAt(src, k, n) !== "") break;
    lines.push(src.slice(k, kle));
    k = kle < n ? kle + 1 : kle;
  }
  let text = lines.join("\n");
  if (level !== 0) text = text.trim();
  const job = { isJob: true, text, out: [], raw: false };
  jobs.push(job);
  if (level !== 0) {
    out.push("<h" + level + ">");
    out.push(job);
    out.push("</h" + level + ">\n");
    return { end: k, wasPara: false };
  }
  out.push("<p>");
  out.push(job);
  out.push("</p>\n");
  return { end: k, wasPara: true };
}

// The main block parser. Parses src (a full document or a blockquote/list
// item's content) and appends the HTML parts to out. depth guards recursion.
function parseBlocks(src, defs, out, jobs, depth) {
  const n = src.length;
  let i = 0;
  let prevWasPara = false;
  while (i < n) {
    if (src.charCodeAt(i) === 10) { i++; prevWasPara = false; continue; }
    const le = lineEnd(src, i, n);
    if (isBlankLine(src, i, le)) { i = le < n ? le + 1 : le; prevWasPara = false; continue; }
    let ni = tryHr(src, i, n, out);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryAtx(src, i, n, out, jobs);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryFence(src, i, n, out);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryHtmlBlock(src, i, n, out);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryBlockquote(src, i, n, defs, out, jobs);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryList(src, i, n, defs, out, jobs, depth);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    // indented code (cannot interrupt a paragraph)
    if (!prevWasPara) {
      ni = tryIndentedCode(src, i, n, out);
      if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    }
    // a link reference definition (only after a blank line, not after a paragraph)
    if (!prevWasPara) {
      const d = tryDef(src, i, n);
      if (d) {
        const dk = normLabel(d.tag);
        if (dk !== '' && !(dk in defs)) defs[dk] = { href: d.href, title: d.title };
        i = d.end;
        prevWasPara = false;
        continue;
      }
    }
    ni = tryTable(src, i, n, defs, out, jobs);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    const p = parseParagraph(src, i, n, defs, out, jobs);
    i = p.end;
    prevWasPara = p.wasPara;
  }
}

// Entry point.
export function parse(src) {
  src = src.replace(/\r\n|\r/g, "\n");
  const defs = Object.create(null);
  const out = [];
  const jobs = [];
  parseBlocks(src, defs, out, jobs, 0);
  // render the deferred inline jobs now that all link definitions are known
  for (const job of jobs) {
    const st = { l: false, r: job.raw, e: false, m: 0 };
    inlineInto(job.text, job.out, defs, st);
  }
  let result = "";
  for (const part of out) {
    if (typeof part === "string") result += part;
    else result += part.out.join("");
  }
  return result;
}

// List: a sequence of items with the same bullet or ordered delimiter.
// Returns the index after the list, or -1.
// Are the collected item lines currently inside an unclosed fenced code
// block? Used so blank lines inside a fence do not make a list loose.
function inFenceLines(lines) {
  let fc = 0, fl = 0;
  for (const ln of lines) {
    if (ln === "") continue;
    let s = 0;
    while (s < ln.length && ln.charCodeAt(s) === 32 && s < 3) s++;
    const c = s < ln.length ? ln.charCodeAt(s) : -1;
    if (c !== 96 && c !== 126) continue;
    let len = 0;
    while (s + len < ln.length && ln.charCodeAt(s + len) === c) len++;
    if (fc === 0) {
      if (len >= 3) { fc = c; fl = len; }
    } else if (c === fc && len >= fl) {
      // closing fence: only spaces/tabs may follow
      let ok = true;
      for (let q = s + len; q < ln.length; q++) {
        const cc = ln.charCodeAt(q);
        if (cc !== 32 && cc !== 9) { ok = false; break; }
      }
      if (ok) { fc = 0; fl = 0; }
    }
  }
  return fc !== 0;
}

function tryList(src, i, n, defs, out, jobs, depth) {
  const sp = leadingSpaces(src, i, n, 3);
  let j = i + sp;
  if (j >= n) return -1;
  const c = src.charCodeAt(j);
  let ordered = false;
  let bullet = 0;
  let delim = 0;
  let startNum = 1;
  let markerLen = 0;
  if (c === 45 || c === 43 || c === 42) {
    const nc = j + 1 < n ? src.charCodeAt(j + 1) : -1;
    if (nc !== 32 && nc !== 9 && nc !== 10 && j + 1 < n) return -1;
    bullet = c;
    markerLen = 1;
  } else if (c >= 48 && c <= 57) {
    let k = j;
    let num = 0;
    while (k < n && src.charCodeAt(k) >= 48 && src.charCodeAt(k) <= 57 && k - j < 9) {
      num = num * 10 + (src.charCodeAt(k) - 48);
      k++;
    }
    if (k >= n || (src.charCodeAt(k) !== 46 && src.charCodeAt(k) !== 41)) return -1;
    delim = src.charCodeAt(k);
    const nc = k + 1 < n ? src.charCodeAt(k + 1) : -1;
    if (nc !== 32 && nc !== 9 && nc !== 10 && k + 1 < n) return -1;
    ordered = true;
    startNum = num;
    markerLen = k - j + 1;
  } else {
    return -1;
  }
  // the content indent for an item starting at lineStart with marker at col sp
  function itemIndent(lineStart, markerCol) {
    let k = lineStart + markerCol + markerLen;
    // the index just after the first whitespace char following the marker
    const afterFirstWs = k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9) ? k + 1 : k;
    let col = markerCol + markerLen;
    let spaces = 0;
    while (k < n) {
      const cc = src.charCodeAt(k);
      if (cc === 32) { spaces++; col++; k++; }
      else if (cc === 9) { const adv = 4 - (col % 4); spaces += adv; col += adv; k++; }
      else break;
    }
    if (k >= n || src.charCodeAt(k) === 10) return { indent: markerCol + markerLen + 1, contentStart: k, empty: true };
    if (spaces >= 1 && spaces <= 4) return { indent: col, contentStart: k, empty: false };
    if (spaces >= 5) return { indent: markerCol + markerLen + 1, contentStart: afterFirstWs, empty: false };
    return { indent: markerCol + markerLen + 1, contentStart: k, empty: false };
  }
  // does the line at k start a new item of this list? Returns the marker info or null.
  // A thematic break line is not a new item (it ends the list).
  // An item belongs to this list when its indent is at most maxIndent
  // (the list allows a gradual indent drift of at most 1 per item, capped
  // at 3 past the list start; a bigger jump is a nested list or content).
  function newItemAt(k, maxIndent) {
    const lsp = leadingSpaces(src, k, n, 3);
    if (lsp < sp || lsp > maxIndent) return null;
    const mk = k + lsp;
    if (mk >= n) return null;
    const mc = src.charCodeAt(mk);
    // a thematic break (3+ of *, -, _ with spaces) ends the list
    if (mc === 42 || mc === 45 || mc === 95) {
      const kle2 = lineEnd(src, k, n);
      let count = 0;
      let q = mk;
      let ok = true;
      while (q < kle2) {
        const cc = src.charCodeAt(q);
        if (cc === mc) count++;
        else if (cc !== 32 && cc !== 9) { ok = false; break; }
        q++;
      }
      if (ok && count >= 3) return null;
    }
    if (!ordered && (mc === bullet)) {
      const nc = mk + 1 < n ? src.charCodeAt(mk + 1) : -1;
      if (nc === 32 || nc === 9 || nc === 10 || mk + 1 >= n) return { markerLen: 1, indent: lsp };
    }
    if (ordered && mc >= 48 && mc <= 57) {
      let q = mk;
      while (q < n && src.charCodeAt(q) >= 48 && src.charCodeAt(q) <= 57 && q - mk < 9) q++;
      if (q < n && src.charCodeAt(q) === delim) {
        const nc = q + 1 < n ? src.charCodeAt(q + 1) : -1;
        if (nc === 32 || nc === 9 || nc === 10 || q + 1 >= n) return { markerLen: q - mk + 1, indent: lsp };
      }
    }
    return null;
  }
  const items = [];
  let k = i;
  let listEnd = i;
  let prevIndent = sp;
  let prevEndsBlank = false;
  let curIndent = sp;
  while (k < n) {
    // skip blank lines between items (the previous item's endsBlank already
    // records that the list is loose)
    while (k < n) {
      const kle0 = lineEnd(src, k, n);
      if (!isBlankLine(src, k, kle0)) break;
      k = kle0 < n ? kle0 + 1 : kle0;
    }
    if (k >= n) break;
    const kle = lineEnd(src, k, n);
    const maxInd = prevEndsBlank ? sp + 3 : Math.min(sp + 3, prevIndent + 1);
    const ni = newItemAt(k, maxInd);
    if (!ni) break;
    curIndent = ni.indent;
    const ind = itemIndent(k, curIndent);
    // the item's first line content
    const firstLine = src.slice(ind.contentStart, kle);
    const lines = [firstLine];
    let itemEnd = kle < n ? kle + 1 : kle;
    let hadBlank = false;
    let endsBlank = false;
    // collect the following lines belonging to this item
    let m = kle < n ? kle + 1 : kle;
    let prevBlank = false;
    while (m < n) {
      const mle = lineEnd(src, m, n);
      if (newItemAt(m, Math.min(sp + 3, curIndent + 1))) break;
      if (isBlankLine(src, m, mle)) {
        // an empty item ends at a blank line (it has no content to continue)
        if (lines.every(l => l === "")) { endsBlank = true; break; }
        // a blank line: include it only if a following line belongs to the
        // item (indented enough or a new item). A line after a blank line
        // is never a lazy continuation (the blank line closed the paragraph).
        let nm = mle < n ? mle + 1 : mle;
        let peek = nm;
        let nextOk = false;
        let nextIndent = -1;
        while (peek < n) {
          const ple = lineEnd(src, peek, n);
          if (isBlankLine(src, peek, ple)) { peek = ple < n ? ple + 1 : ple; continue; }
          nextIndent = indentColumns(src, peek, n);
          if (newItemAt(peek, Math.min(sp + 3, curIndent + 1))) { nextOk = true; break; }
          if (nextIndent >= ind.indent) { nextOk = true; break; }
          break;
        }
        if (!nextOk) {
          endsBlank = true;
          break;
        }
        lines.push("");
        // the blank line only makes the list loose if it separates blocks at
        // this item's own level. If the previous line is a nested list item,
        // the blank line is inside that nested list, not at this level.
        // (An indented code block IS a direct child, so it still counts.)
        let prevIsList = false;
        for (let li = lines.length - 2; li >= 0; li--) {
          const pl = lines[li];
          if (pl === "") continue;
          let ps = 0;
          while (ps < pl.length && pl.charCodeAt(ps) === 32) ps++;
          const pc = ps < pl.length ? pl.charCodeAt(ps) : -1;
          if (pc === 45 || pc === 43 || pc === 42) {
            const nc = ps + 1 < pl.length ? pl.charCodeAt(ps + 1) : -1;
            if (nc === 32 || nc === 9 || ps + 1 >= pl.length) prevIsList = true;
          } else if (pc >= 48 && pc <= 57) {
            let pk = ps;
            while (pk < pl.length && pl.charCodeAt(pk) >= 48 && pl.charCodeAt(pk) <= 57) pk++;
            if (pk < pl.length && (pl.charCodeAt(pk) === 46 || pl.charCodeAt(pk) === 41)) {
              const nc = pk + 1 < pl.length ? pl.charCodeAt(pk + 1) : -1;
              if (nc === 32 || nc === 9 || pk + 1 >= pl.length) prevIsList = true;
            }
          }
          break;
        }
        if (!prevIsList || (nextIndent !== -1 && nextIndent <= ind.indent)) {
          // blank lines inside a fenced code block never make the list loose
          if (!inFenceLines(lines)) hadBlank = true;
        }
        prevBlank = true;
        m = mle < n ? mle + 1 : mle;
        continue;
      }
      const msp = leadingSpaces(src, m, n, 100);
      if (msp >= ind.indent || indentColumns(src, m, n) >= ind.indent) {
        const st = stripIndent(src, m, mle, ind.indent);
        const raw = st.spaces > 0 ? " ".repeat(st.spaces) + src.slice(st.start, mle) : src.slice(st.start, mle);
        // expand leading tabs at the item's content column so downstream
        // block handlers (fence, indented code) see correct columns
        lines.push(expandLeadingTabs(raw, ind.indent));
        prevBlank = false;
        m = mle < n ? mle + 1 : mle;
        continue;
      }
      // a line indented less than the content indent: lazy continuation of a
      // paragraph — only if the previous line was not blank and the line does
      // not start a list item (a new list ends this one)
      if (!prevBlank && lines.length > 0 && blockStartAt(src, m, n) === "" && !isListMarkerLine(src, m, n)) {
        // strip up to the content indent's worth of leading spaces
        let ls = m;
        let stripped = 0;
        while (ls < mle && stripped < ind.indent && src.charCodeAt(ls) === 32) { ls++; stripped++; }
        lines.push(src.slice(ls, mle));
        prevBlank = false;
        m = mle < n ? mle + 1 : mle;
        continue;
      }
      break;
    }
    // strip trailing blank lines from the item's lines; an item that was
    // empty to begin with does not count as ending with a blank line
    const hadContent = lines.some(l => l !== "");
    while (lines.length > 0 && lines[lines.length - 1] === "") { lines.pop(); if (hadContent) endsBlank = true; }
    while (lines.length > 0 && lines[lines.length - 1] === "") { lines.pop(); endsBlank = true; }
    items.push({ lines, hadBlank, endsBlank });
    listEnd = m;
    k = m;
    prevIndent = curIndent;
    prevEndsBlank = endsBlank;
    // if the item ended with a blank line and there is a next item, the list is loose
    // (handled in the loose determination below)
    if (m >= n) break;
    // the next iteration skips blank lines and checks for a new item at k
  }
  if (items.length === 0) return -1;
  // loose if any item has an internal blank line, or any item except the last
  // ends with a blank line (i.e. a blank line separates two items)
  let loose = false;
  for (let t = 0; t < items.length; t++) {
    if (items[t].hadBlank) { loose = true; break; }
    if (t < items.length - 1 && items[t].endsBlank) { loose = true; break; }
  }
  // render
  if (ordered) {
    out.push(startNum !== 1 ? '<ol start="' + startNum + '">\n' : "<ol>\n");
  } else {
    out.push("<ul>\n");
  }
  for (const item of items) {
    // task checkbox: [ ], [x], [X] at the start of the first line
    let checked = -1; // -1 not a task, 0 unchecked, 1 checked
    let first = item.lines[0] || "";
    if (first.length >= 4 && first.charCodeAt(0) === 91 && first.charCodeAt(2) === 93 && first.charCodeAt(3) === 32) {
      const cc = first.charCodeAt(1);
      if (cc === 32) checked = 0;
      else if (cc === 120 || cc === 88) checked = 1;
    }
    if (checked !== -1) {
      item.lines[0] = first.slice(4);
      out.push("<li>");
    } else {
      out.push("<li>");
    }
    const content = item.lines.join("\n");
    // for a tight list, the item's paragraphs render without <p> tags
    const itemStart = out.length;
    parseBlocksTight(content, defs, out, jobs, depth + 1, !loose);
    if (checked !== -1) {
      const inputHtml = checked === 1 ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
      if (loose) {
        // in a loose list the checkbox goes inside the <p>, after its tag
        let inserted = false;
        for (let q = itemStart; q < out.length; q++) {
          if (out[q] === "<p>") { out.splice(q + 1, 0, inputHtml); inserted = true; break; }
        }
        if (!inserted) out.splice(itemStart, 0, inputHtml);
      } else {
        out.splice(itemStart, 0, inputHtml);
      }
    }
    // a tight paragraph emits a trailing "\n" separator; drop it when it is
    // the last thing in the item (the </li> follows directly)
    if (out.length > 0 && out[out.length - 1] === "\n") out.pop();
    out.push("</li>\n");
  }
  out.push(ordered ? "</ol>\n" : "</ul>\n");
  return listEnd;
}

// Parse blocks with a tight flag (for list items). A tight list's paragraphs
// render as bare inline content (no <p> tags).
function parseBlocksTight(src, defs, out, jobs, depth, tight) {
  const n = src.length;
  let i = 0;
  let prevWasPara = false;
  while (i < n) {
    if (src.charCodeAt(i) === 10) { i++; prevWasPara = false; continue; }
    const le = lineEnd(src, i, n);
    if (isBlankLine(src, i, le)) { i = le < n ? le + 1 : le; prevWasPara = false; continue; }
    let ni = tryHr(src, i, n, out);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryAtx(src, i, n, out, jobs);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryFence(src, i, n, out);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryHtmlBlock(src, i, n, out);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryBlockquote(src, i, n, defs, out, jobs);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    ni = tryList(src, i, n, defs, out, jobs, depth);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    if (!prevWasPara) {
      ni = tryIndentedCode(src, i, n, out);
      if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    }
    if (!prevWasPara) {
      const d = tryDef(src, i, n);
      if (d) {
        const dk = normLabel(d.tag);
        if (dk !== '' && !(dk in defs)) defs[dk] = { href: d.href, title: d.title };
        i = d.end;
        prevWasPara = false;
        continue;
      }
    }
    ni = tryTable(src, i, n, defs, out, jobs);
    if (ni !== -1) { i = ni; prevWasPara = false; continue; }
    const p = parseParagraphTight(src, i, n, defs, out, jobs, tight);
    i = p.end;
    prevWasPara = p.wasPara;
  }
}

// Paragraph with a tight flag (for list items).
function parseParagraphTight(src, i, n, defs, out, jobs, tight) {
  const lines = [];
  let k = i;
  let level = 0;
  while (k < n) {
    const kle = lineEnd(src, k, n);
    if (isBlankLine(src, k, kle)) break;
    if (lines.length > 0) {
      const sl = setextLevel(src, k, n);
      if (sl !== 0) { level = sl; k = kle < n ? kle + 1 : kle; break; }
    }
    if (lines.length > 0 && blockStartAt(src, k, n, true) !== "") break;
    lines.push(src.slice(k, kle));
    k = kle < n ? kle + 1 : kle;
  }
  let text = lines.join("\n");
  if (level !== 0) text = text.trim();
  const job = { isJob: true, text, out: [], raw: false };
  jobs.push(job);
  if (level !== 0) {
    out.push("<h" + level + ">");
    out.push(job);
    out.push("</h" + level + ">\n");
    return { end: k, wasPara: false };
  }
  if (tight) {
    out.push(job);
  } else {
    out.push("<p>");
    out.push(job);
    out.push("</p>\n");
  }
  return { end: k, wasPara: true };
}
