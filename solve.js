// A fast drop-in for makefun-site 1.0.0: same answers, less CPU.
// Written from the makefun-site README and the reference program's behaviour.
// How it is faster:
// - Templates are compiled to JavaScript with their includes inlined and with
//   loop bindings as plain locals, so a page renders in one function call and
//   no scope-chain objects are built per include or per loop iteration.
// - Markdown renders in one pass over its lines (first-character dispatch),
//   and inline markup scans with one shared regex plus indexOf-based searches
//   for its closers instead of character-by-character scans.
// - Front matter is read by scanning only its own lines; the body is sliced,
//   never split and re-joined. Files with no carriage return are not copied.
// - Slugs are cached per build, word counts use an inlined whitespace test,
//   and repeated link resolutions are memoised per build.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const hasOwn = Object.prototype.hasOwnProperty;

/** Code-unit order. */
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

// ---------------------------------------------------------------- text

const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape a string; returns it untouched when nothing needs it. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_ALL, (c) => ESC_MAP[c]);
}

/** The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left. */
function slugBody(s) {
  let out = '';
  let gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let k = -1;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    if (k < 0) { if (out.length > 0) gap = true; continue; }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(k);
  }
  let end = out.length > 64 ? 64 : out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  const plain = ascii ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  const out = slugBody(plain);
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = next.get(slug) || 2;
  for (;;) {
    const c = slug + '-' + n;
    if (!taken.has(c)) { taken.add(c); next.set(slug, n + 1); return c; }
    n++;
  }
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  return Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
}

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s set). */
function isWSChar(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

/** Count runs of non-whitespace in `text`. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Printable ASCII other than space is never whitespace: two compares
    // cover the common case; only control and non-ASCII chars need the set.
    if (c > 32 && c < 127) { if (!inWord) { n++; inWord = true; } }
    else if (isWSChar(c)) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` resolved from directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}

/** A source's front matter and body: { data, body }, or { error }. Scans only
 * the front matter's own lines and slices the body out of the text. */
function parseFM(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  const data = {};
  let pos = 4;
  let lineNo = 2;
  let closeEnd = -1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    if (line === '---') { closeEnd = nl === -1 ? text.length : nl + 1; break; }
    if (!isBlankLine(line) && line[0] !== '#') {
      const m = FM_LINE.exec(line);
      if (!m) return { error: 'line ' + lineNo + ' is not "key: value"' };
      const key = m[1];
      const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
      if (FM_KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
      if (hasOwn.call(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
    lineNo++;
  }
  if (!hasOwn.call(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const HAS_WS = /\s/;
/** The one shared inline scanner; inline() resets lastIndex on entry and
 * restores it after every nested call, so sharing it is safe. */
const INLINE_RX = /[\\`*\[&<>"']/g;
/** Markup characters only (no escapes): text without one needs no inline
 * scan at all, just escaping. */
const MARKUP_TEST = /[\\`*[]/;

function trimLT(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  // Nothing to trim: hand the string back itself, not a slice view of it.
  if (a === 0 && b === s.length) return s;
  return s.slice(a, b);
}

/** Whether the character at `p` is escaped by an odd run of backslashes. */
function isEscapedAt(s, p) {
  let n = 0;
  for (let q = p - 1; q >= 0 && s.charCodeAt(q) === 92; q--) n++;
  return (n & 1) === 1;
}

/** First `**` at or after `from` whose first star is not escaped, or -1. */
function closeStrong(s, from) {
  let p = s.indexOf('**', from);
  while (p !== -1) {
    if (!isEscapedAt(s, p)) return p;
    p = s.indexOf('**', p + 1);
  }
  return -1;
}

/** First single `*` at or after `from` (one whose run is not `**`), unescaped, or -1. */
function closeEm(s, from) {
  let p = s.indexOf('*', from);
  while (p !== -1) {
    if (isEscapedAt(s, p)) { p = s.indexOf('*', p + 1); continue; }
    if (s.charCodeAt(p + 1) === 42) { p = s.indexOf('*', p + 2); continue; }
    return p;
  }
  return -1;
}

/** First `]` at or after `from` that is not escaped, or -1. */
function closeBracket(s, from) {
  let p = s.indexOf(']', from);
  while (p !== -1) {
    if (!isEscapedAt(s, p)) return p;
    p = s.indexOf(']', p + 1);
  }
  return -1;
}

/** `s` rendered inline; `link(target)` resolves a link's href. */
function inline(s, link) {
  // No markup character: the text needs only escaping, and esc() does that
  // with a single test (returning the string itself when there is nothing
  // to escape). This is the common case, and it skips the inline scan.
  if (!MARKUP_TEST.test(s)) return esc(s);
  const rx = INLINE_RX;
  rx.lastIndex = 0;
  let out = '';
  let plain = 0;
  let m;
  while ((m = rx.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        if (j > plain) out += s.slice(plain, j);
        out += s[j + 1] === '>' ? '&gt;' : s[j + 1];
        plain = j + 2;
        rx.lastIndex = plain;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out += s.slice(plain, j);
        out += '<code>' + esc(s.slice(j + 1, k)) + '</code>';
        plain = k + 1;
        rx.lastIndex = plain;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(j + 1) === 42) {
        const k = closeStrong(s, j + 2);
        if (k > j + 2) {
          if (j > plain) out += s.slice(plain, j);
          out += '<strong>' + inline(s.slice(j + 2, k), link) + '</strong>';
          plain = k + 2;
          rx.lastIndex = plain;
        } else rx.lastIndex = j + 2;
        continue;
      }
      const k = closeEm(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out += s.slice(plain, j);
        out += '<em>' + inline(s.slice(j + 1, k), link) + '</em>';
        plain = k + 1;
        rx.lastIndex = plain;
      }
      continue;
    }
    if (c === '[') {
      const k = closeBracket(s, j + 1);
      let q = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) q = s.indexOf(')', k + 2);
      if (q !== -1) {
        const target = s.slice(k + 2, q);
        if (target !== '' && !HAS_WS.test(target)) {
          if (j > plain) out += s.slice(plain, j);
          out += '<a href="' + esc(link(target)) + '">' + inline(s.slice(j + 1, k), link) + '</a>';
          plain = q + 1;
          rx.lastIndex = plain;
        }
      }
      continue;
    }
    if (j > plain) out += s.slice(plain, j);
    out += c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    plain = j + 1;
  }
  if (plain < s.length) out += s.slice(plain);
  return out;
}

/** Fence-open language of `line`, or null when it is not a fence opener. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A heading line's depth and text, or null. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (line[d] !== ' ' && line[d] !== '\t') return null;
  let i = d;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  const text = trimLT(line.slice(i));
  if (text === '') return null;
  return { depth: d, text };
}

function isHR(line) {
  if (line.length < 3) return false;
  const dash = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const star = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break. */
function endsPara(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankLine(line);
  if (c === 96) return fenceLang(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHR(line);
  return false;
}

/** A list item's start: { ordered, start, text } or null. */
function listStart(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, text: trimLT(line.slice(2)) };
  if (c0 >= 48 && c0 <= 57) {
    let d = 0;
    while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
    if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
      return { ordered: true, start: Number(line.slice(0, d)), text: trimLT(line.slice(d + 2)) };
    }
  }
  return null;
}

/** A list continuation line (two or more spaces, then a non-space). */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  return !isWSChar(line.charCodeAt(k));
}

/** `src` rendered: { html, toc, excerpt }. One pass over its lines. */
function renderMD(src, link, slugCache) {
  const lines = src.split('\n');
  let html = '';
  const toc = [];
  const ids = new Set();
  const nextIds = new Map();
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.length === 0) { i++; continue; }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlankLine(line)) { i++; continue; }
    } else if (c0 === 96) {
      const lang = fenceLang(line);
      if (lang !== null) {
        i++;
        let code = '';
        while (i < lines.length && !fenceClose(lines[i])) { code += esc(lines[i]) + '\n'; i++; }
        i++;
        html += '<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>' + code + '</code></pre>\n';
        continue;
      }
    } else if (c0 === 35) {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text, slugCache), ids, nextIds);
        const h = inline(hd.text, link);
        html += '<h' + hd.depth + ' id="' + id + '">' + h + '</h' + hd.depth + '>\n';
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html: h });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHR(line)) { html += '<hr>\n'; i++; continue; }
      const ls = listStart(line);
      if (ls !== null) {
        const items = [[ls.text]];
        const ordered = ls.ordered;
        const start = ls.start;
        i++;
        while (i < lines.length) {
          const m2 = listStart(lines[i]);
          if (m2 !== null && m2.ordered === ordered) { items.push([m2.text]); i++; }
          else if (isContinued(lines[i])) { items[items.length - 1].push(trimLT(lines[i])); i++; }
          else break;
        }
        html += (ordered && start !== 1 ? '<ol start="' + start + '">\n' : ordered ? '<ol>\n' : '<ul>\n');
        for (const parts of items) html += '<li>' + inline(parts.length === 1 ? parts[0] : parts.join('\n'), link) + '</li>\n';
        html += (ordered ? '</ol>' : '</ul>') + '\n';
        continue;
      }
    } else if (c0 === 62) {
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let l = lines[i].slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        const t = trimLT(l);
        if (t !== '') kept.push(t);
        i++;
      }
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : '<blockquote>\n<p>' + inline(kept.length === 1 ? kept[0] : kept.join('\n'), link) + '</p>\n</blockquote>\n';
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ls = listStart(line);
      if (ls !== null) {
        const items = [[ls.text]];
        const start = ls.start;
        i++;
        while (i < lines.length) {
          const m2 = listStart(lines[i]);
          if (m2 !== null && m2.ordered) { items.push([m2.text]); i++; }
          else if (isContinued(lines[i])) { items[items.length - 1].push(trimLT(lines[i])); i++; }
          else break;
        }
        html += (start !== 1 ? '<ol start="' + start + '">\n' : '<ol>\n');
        for (const parts of items) html += '<li>' + inline(parts.length === 1 ? parts[0] : parts.join('\n'), link) + '</li>\n';
        html += '</ol>\n';
        continue;
      }
    }
    const first = trimLT(line);
    i++;
    if (i >= lines.length || endsPara(lines[i])) {
      const h = inline(first, link);
      if (excerpt === null) excerpt = h;
      html += '<p>' + h + '</p>\n';
      continue;
    }
    const parts = [first];
    while (i < lines.length && !endsPara(lines[i])) { parts.push(trimLT(lines[i])); i++; }
    const h = inline(parts.join('\n'), link);
    if (excerpt === null) excerpt = h;
    html += '<p>' + h + '</p>\n';
  }
  return { html, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TErr extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TErr('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

function tokenize(name, src) {
  const toks = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const nx = src[open + 1];
    if (nx !== '{' && nx !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (nx === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TErr('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') { toks.push({ k: 't', s: text }); text = ''; }
      toks.push({ k: raw ? 'r' : 'v', p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TErr('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let j = lineStart; j < open; j++) if (src[j] !== ' ' && src[j] !== '\t') { standalone = false; break; }
    if (standalone) for (let j = end; j < lineEnd; j++) if (src[j] !== ' ' && src[j] !== '\t') { standalone = false; break; }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { toks.push({ k: 't', s: text }); text = ''; }
    toks.push({ k: 'g', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') toks.push({ k: 't', s: text });
  return toks;
}

/** Parse a template source into nodes; throws TErr when it does not parse. */
function parseTemplate(name, src) {
  const root = { k: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.k === 't') { body.push({ k: 't', s: tok.s }); continue; }
    if (tok.k === 'v' || tok.k === 'r') { body.push({ k: tok.k, p: tok.p }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { k: 'f', name: m[1], p: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { k: 'i', not: m[1] !== undefined, p: pathOf(name, m[2]), then: [], els: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.k !== 'i' || top.els !== null) throw new TErr('template "' + name + '": an else outside an if');
      top.els = [];
      body = top.els;
    } else if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'f' : 'i';
      if (top.k !== want) throw new TErr('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.k === 'root' ? parent.body : parent.k === 'f' ? parent.body : (parent.els !== null ? parent.els : parent.then);
    } else if ((m = INC_RE.exec(tag)) !== null) {
      body.push({ k: 'c', name: m[1] });
    } else throw new TErr('template "' + name + '": {% ' + tag + ' %} is not a tag');
  }
  if (stack.length > 1) {
    const un = stack[stack.length - 1];
    throw new TErr('template "' + name + '": a ' + (un.k === 'f' ? 'for' : 'if') + ' is not closed');
  }
  return root.body;
}

/** A value as text: string itself, a number's digits, true/false, an array joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) { if (i > 0) s += ', '; s += textOf(v[i]); }
    return s;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Own property `key` of an object value, or undefined. */
function getProp(v, key) {
  if (v === null || typeof v !== 'object') return undefined;
  return hasOwn.call(v, key) ? v[key] : undefined;
}

/** Compile parsed nodes into a render function (V, e, x, y, g). Includes are
 * inlined at compile time (depth-capped at 8, as the reference renders them),
 * and loop bindings become plain locals, so rendering needs no scope chain. */
function compileTop(nodes, parsed) {
  let slots = 0;
  const out = [];
  function exprOf(path, bindings) {
    const first = path[0];
    let base;
    if (first === 'loop') {
      base = bindings.length > 0 ? '$l' + bindings[bindings.length - 1].slot : 'V.loop';
    } else {
      let slot = -1;
      for (let b = bindings.length - 1; b >= 0; b--) {
        if (bindings[b].name === first) { slot = bindings[b].slot; break; }
      }
      base = slot >= 0 ? '$v' + slot : 'V.' + first;
    }
    for (let k = 1; k < path.length; k++) base = 'g(' + base + ',' + JSON.stringify(path[k]) + ')';
    return base;
  }
  function gen(ns, bindings, depth) {
    for (const nd of ns) {
      if (nd.k === 't') out.push('S+=' + JSON.stringify(nd.s) + ';');
      else if (nd.k === 'v') out.push('S+=e(x(' + exprOf(nd.p, bindings) + '));');
      else if (nd.k === 'r') out.push('S+=x(' + exprOf(nd.p, bindings) + ');');
      else if (nd.k === 'i') {
        out.push('if(' + (nd.not ? '!' : '') + 'y(' + exprOf(nd.p, bindings) + ')){');
        gen(nd.then, bindings, depth);
        if (nd.els) { out.push('}else{'); gen(nd.els, bindings, depth); }
        out.push('}');
      } else if (nd.k === 'f') {
        const s = slots++;
        out.push('{const $a' + s + '=' + exprOf(nd.p, bindings) + ';if(Array.isArray($a' + s + ')){const $n' + s + '=$a' + s + '.length;$l' + s + '={index:0,first:false,last:false,length:$n' + s + '};for(let $i' + s + '=0;$i' + s + '<$n' + s + ';$i' + s + '++){$v' + s + '=$a' + s + '[$i' + s + '];$l' + s + '.index=$i' + s + '+1;$l' + s + '.first=$i' + s + '===0;$l' + s + '.last=$i' + s + '===$n' + s + '-1;');
        gen(nd.body, bindings.concat([{ name: nd.name, slot: s }]), depth);
        out.push('}}}');
      } else if (nd.k === 'c') {
        if (depth < INCLUDE_DEPTH) {
          const sub = parsed.get(nd.name);
          if (sub !== undefined) gen(sub, bindings, depth + 1);
        }
      }
    }
  }
  gen(nodes, [], 0);
  let head = 'let S="";';
  if (slots > 0) {
    const vs = [];
    const ls = [];
    for (let s = 0; s < slots; s++) { vs.push('$v' + s); ls.push('$l' + s); }
    head += 'let ' + vs.join(',') + ';let ' + ls.join(',') + ';';
  }
  return new Function('V', 'e', 'x', 'y', 'g', head + out.join('') + 'return S;');
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  const colon = t.indexOf(':');
  if (colon === -1) return false;
  for (let i = 1; i < colon; i++) {
    const c = t.charCodeAt(i);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return true;
}

function linkOf(s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date === undefined ? '' : s.data.date, date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date === undefined ? '' : s.data.date,
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary === undefined ? '' : s.data.summary,
    excerpt: s.excerpt,
    reading_minutes: s.rm !== undefined ? s.rm : (s.rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200))),
    // The tag references already carry exactly the name, slug and url a card
    // shows; templates read nothing else from them, so share them as-is.
    tags: s.tagRefs,
  };
}

function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    // renderMD's toc entries already are { level, id, html } in that order,
    // so share them instead of mapping a fresh array of fresh objects.
    toc: s.toc,
    newer: linkOf(s.newer === undefined ? null : s.newer),
    older: linkOf(s.older === undefined ? null : s.older),
    is_post: s.post,
  };
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const parsed = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(cmp);
  for (const name of names) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (e) {
      if (!(e instanceof TErr)) throw e;
      report.push(e.message);
    }
  }
  const compiled = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  // Front matter and the refusal checks, in order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) { report.push('refused ' + s.path + ': ' + fm.error); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = undefined;
    for (const d of RESERVED) if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    if (own !== undefined) { report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own'); continue; }
    if (s.post && !hasOwn.call(s.data, 'date')) { report.push('refused ' + s.path + ': a post needs a date'); continue; }
    const layout = s.data.layout === undefined ? (s.post ? 'post' : 'page') : s.data.layout;
    if (!parsed.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources.length = 0;
  for (const s of kept) sources.push(s);
  // Permalinks.
  const taken = new Map();
  const next = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug === undefined ? slugify(s.data.title, slugCache) : s.data.slug, set, next);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }
  // Markdown, with links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const resolveCache = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      let path = null;
      if (rel !== '') {
        const key = dir + '\n' + rel;
        if (resolveCache.has(key)) path = resolveCache.get(key);
        else { path = resolvePath(dir, rel); resolveCache.set(key, path); }
      }
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMD(s.body, link, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
  // Collections: posts newest first, equal dates by slug.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const arr = p.data.tags === undefined ? [] : p.data.tags;
    for (const name of arr) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) { tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const arr = s.data.tags === undefined ? [] : s.data.tags;
    for (const name of arr) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      s.tagRefs.push(bySlug.get(slug) || { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));
  // Layouts.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  // One vars object per build (null prototype, so a direct read of a missing
  // name is undefined exactly as the reference's lookup); its per-render keys
  // are rewritten on every call.
  const V = Object.create(null);
  V.site = site;
  V.tags = allTags;
  V.recent = recent;
  const render = (name, vars) => {
    let fn = compiled.get(name);
    if (fn === undefined) {
      const nodes = parsed.get(name);
      if (nodes === undefined) return null;
      fn = compileTop(nodes, parsed);
      compiled.set(name, fn);
    }
    V.page = vars.page;
    V.posts = vars.posts;
    V.pager = vars.pager;
    V.tag = vars.tag;
    return fn(V, esc, textOf, truthy, getProp);
  };
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s, card) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn.call(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }
  // Report.
  const lines = [...report, ...broken].sort(cmp);
  const nPages = sources.filter((s) => !s.post).length;
  lines.push('built ' + nPages + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
