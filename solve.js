// A fast drop-in for makefun-site 1.0.0: same answers, less CPU.
// Written from the makefun-site README and its observable behaviour.
// Strategy: templates are compiled once per build into plain JavaScript
// (loop bindings become locals, includes share one output array), Markdown
// is rendered in a single pass over its lines with no token objects, slugs
// are cached per build, and every hot helper avoids regexes.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const hasOwn = Object.prototype.hasOwnProperty;

/** Code-unit order. */
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** HTML-escape a whole string; returns the input untouched when nothing needs it. */
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let rep = null;
    if (c === '&') rep = '&amp;';
    else if (c === '<') rep = '&lt;';
    else if (c === '>') rep = '&gt;';
    else if (c === '"') rep = '&quot;';
    else if (c === "'") rep = '&#39;';
    if (rep !== null) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

/** Escape one character (only '>' among the backslash-escapable set needs it). */
function escCh(c) { return c === '>' ? '&gt;' : c; }

/** Whether a UTF-16 code unit is JavaScript whitespace. */
function isWS(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 160 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff;
}

/** Slug of `text`, cached in the build's map. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  let end = Math.min(out.length, 64);
  while (end > 0 && out[end - 1] === '-') end--;
  out = out.slice(0, end);
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  for (;;) {
    const c = slug + '-' + n;
    if (!taken.has(c)) { taken.add(c); return c; }
    n++;
  }
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(d) {
  return Number(d.slice(8, 10)) + ' ' + MONTHS[Number(d.slice(5, 7)) - 1] + ' ' + d.slice(0, 4);
}

/** Count runs of non-whitespace in `text`. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
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

/** A source's front matter and body: { data, body }, or { error }. */
function parseFM(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i] === '---') { close = i; break; }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line[0] === '#') continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    let raw = m[2] === undefined ? '' : m[2].replace(/[ \t]+$/, '');
    if (FM_KEYS.indexOf(key) === -1) return { error: 'unknown key "' + key + '"' };
    if (hasOwn.call(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn.call(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function trimLT(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return s.slice(a, b);
}

/** Fence-open language of `line`, or null when it is not a fence opener. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let i = 3;
  let lang = '';
  while (i < line.length) {
    const c = line[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') { lang += c; i++; }
    else break;
  }
  while (i < line.length) {
    if (line[i] !== ' ' && line[i] !== '\t') return null;
    i++;
  }
  return lang;
}

function fenceClose(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

/** A heading line's depth and text, or null. */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line[d] === '#') d++;
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
  const dash = line[0] === '-' && line[1] === '-' && line[2] === '-';
  const star = line[0] === '*' && line[1] === '*' && line[2] === '*';
  if (!dash && !star) return false;
  for (let i = 3; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}

function endsPara(line) {
  return isBlankLine(line) || fenceLang(line) !== null || headingOf(line) !== null || isHR(line);
}

/** A list item's start: { ordered, start, text } or null. */
function listStart(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return { ordered: false, start: 1, text: trimLT(line.slice(2)) };
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d >= 1 && d <= 9 && line[d] === '.' && line[d + 1] === ' ') {
    return { ordered: true, start: Number(line.slice(0, d)), text: trimLT(line.slice(d + 2)) };
  }
  return null;
}

/** A list continuation line (two or more spaces, then a non-space). */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k < 2 || k >= line.length) return false;
  return !isWS(line.charCodeAt(k));
}

/** First index from `from` where `s` holds `ch` outside a backslash escape, or -1. */
function findUnesc(s, ch, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s[j] === ch) return j;
  }
  return -1;
}

/** First `**` from `from` outside an escape, or -1. */
function findStrong(s, from) {
  for (let j = from; j + 1 < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s[j] === '*' && s[j + 1] === '*') return j;
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findEm(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

/** `s` rendered inline; `link(target)` resolves a link's href. */
const INLINE_RE = /[\\`*\[&<>"']/g;
function inline(s, link) {
  const out = [];
  const re = new RegExp(INLINE_RE);
  let plain = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push(escCh(s[j + 1]));
        plain = j + 2;
        re.lastIndex = plain;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        plain = k + 1;
        re.lastIndex = plain;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findStrong(s, j + 2);
        if (k > j + 2) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<strong>', inline(s.slice(j + 2, k), link), '</strong>');
          plain = k + 2;
          re.lastIndex = plain;
        } else re.lastIndex = j + 2;
        continue;
      }
      const k = findEm(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(s.slice(plain, j));
        out.push('<em>', inline(s.slice(j + 1, k), link), '</em>');
        plain = k + 1;
        re.lastIndex = plain;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnesc(s, ']', j + 1);
      let q = -1;
      if (k !== -1 && s[k + 1] === '(') q = s.indexOf(')', k + 2);
      if (q !== -1) {
        const target = s.slice(k + 2, q);
        if (target !== '' && !hasWS(target)) {
          if (j > plain) out.push(s.slice(plain, j));
          out.push('<a href="', esc(link(target)), '">', inline(s.slice(j + 1, k), link), '</a>');
          plain = q + 1;
          re.lastIndex = plain;
        }
      }
      continue;
    }
    if (j > plain) out.push(s.slice(plain, j));
    out.push(c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;');
    plain = j + 1;
  }
  if (plain < s.length) out.push(s.slice(plain));
  return out.join('');
}

/** `src` rendered: { html, toc, excerpt }. */
function renderMD(src, link, slugCache) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      let code = '';
      while (i < lines.length && !fenceClose(lines[i])) { code += esc(lines[i]) + '\n'; i++; }
      i++;
      blocks.push('<pre><code' + (lang === '' ? '' : ' class="language-' + lang + '"') + '>' + code + '</code></pre>');
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const html = inline(hd.text, link);
      blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line[0] === '>') {
      const kept = [];
      while (i < lines.length && lines[i][0] === '>') {
        let l = lines[i].slice(1);
        if (l[0] === ' ') l = l.slice(1);
        const t = trimLT(l);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(kept.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    }
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
      let html = '';
      if (ordered && start !== 1) html += '<ol start="' + start + '">\n';
      else html += ordered ? '<ol>\n' : '<ul>\n';
      for (const parts of items) html += '<li>' + inline(parts.join('\n'), link) + '</li>\n';
      html += ordered ? '</ol>' : '</ul>';
      blocks.push(html);
      continue;
    }
    const parts = [trimLT(line)];
    i++;
    while (i < lines.length && !endsPara(lines[i])) { parts.push(trimLT(lines[i])); i++; }
    const html = inline(parts.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

class TErr extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

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

/** A free name's value: the innermost include frame binding it, else the top values. */
function lookupFrame(F, V, name) {
  if (name === 'loop') return F !== null ? F.l : undefined;
  for (let f = F; f !== null; f = f.p) if (f.n === name) return f.v;
  return hasOwn.call(V, name) ? V[name] : undefined;
}

/** Compile parsed nodes into a render function (V, F, O, C, D). */
function compileTemplate(nodes) {
  let slots = 0;
  const free = [];
  const freeIdx = new Map();
  let incN = 0;
  function noteFree(path, bindings) {
    const first = path[0];
    if (first === 'loop') {
      if (bindings.length === 0 && !freeIdx.has('loop')) { freeIdx.set('loop', free.length); free.push('loop'); }
      return;
    }
    for (let b = bindings.length - 1; b >= 0; b--) if (bindings[b].name === first) return;
    if (!freeIdx.has(first)) { freeIdx.set(first, free.length); free.push(first); }
  }
  function annotate(ns, bindings) {
    for (const nd of ns) {
      if (nd.k === 'v' || nd.k === 'r') noteFree(nd.p, bindings);
      else if (nd.k === 'i') { noteFree(nd.p, bindings); annotate(nd.then, bindings); if (nd.els) annotate(nd.els, bindings); }
      else if (nd.k === 'f') { noteFree(nd.p, bindings); nd.slot = slots++; annotate(nd.body, bindings.concat([{ name: nd.name, slot: nd.slot }])); }
    }
  }
  annotate(nodes, []);
  function exprOf(path, bindings) {
    const first = path[0];
    let base;
    if (first === 'loop' && bindings.length > 0) base = '$l' + bindings[bindings.length - 1].slot;
    else {
      let slot = -1;
      for (let b = bindings.length - 1; b >= 0; b--) if (bindings[b].name === first) { slot = bindings[b].slot; break; }
      base = slot >= 0 ? '$v' + slot : '$h' + freeIdx.get(first);
    }
    for (let k = 1; k < path.length; k++) base = 'C.g(' + base + ',' + JSON.stringify(path[k]) + ')';
    return base;
  }
  const out = [];
  function gen(ns, bindings) {
    for (const nd of ns) {
      if (nd.k === 't') out.push('O.push(' + JSON.stringify(nd.s) + ');');
      else if (nd.k === 'v') out.push('O.push(C.e(C.x(' + exprOf(nd.p, bindings) + ')));');
      else if (nd.k === 'r') out.push('O.push(C.x(' + exprOf(nd.p, bindings) + '));');
      else if (nd.k === 'i') {
        out.push('if(C.y(' + exprOf(nd.p, bindings) + ')!==' + (nd.not ? 'true' : 'false') + '){');
        gen(nd.then, bindings);
        if (nd.els) { out.push('}else{'); gen(nd.els, bindings); }
        out.push('}');
      } else if (nd.k === 'f') {
        const s = nd.slot;
        out.push('{const $a' + s + '=' + exprOf(nd.p, bindings) + ';if(Array.isArray($a' + s + ')){$l' + s + '={index:0,first:false,last:false,length:$a' + s + '.length};const $n' + s + '=$a' + s + '.length;for(let $i' + s + '=0;$i' + s + '<$n' + s + ';$i' + s + '++){$v' + s + '=$a' + s + '[$i' + s + '];$l' + s + '.index=$i' + s + '+1;$l' + s + '.first=$i' + s + '===0;$l' + s + '.last=$i' + s + '===$n' + s + '-1;');
        gen(nd.body, bindings.concat([{ name: nd.name, slot: s }]));
        out.push('}}}');
      } else if (nd.k === 'c') {
        if (bindings.length === 0) {
          out.push('if(D<8){const $f=C.t.get(' + JSON.stringify(nd.name) + ');if($f)$f(V,F,O,C,D+1);}');
        } else {
          const t = incN++;
          let code = 'if(D<8){const $f=C.t.get(' + JSON.stringify(nd.name) + ');if($f){let $c' + t + '=F;';
          for (let b = 0; b < bindings.length; b++) {
            code += '$c' + t + '={n:' + JSON.stringify(bindings[b].name) + ',v:$v' + bindings[b].slot + ',l:$l' + bindings[b].slot + ',p:$c' + t + '};';
          }
          code += '$f(V,$c' + t + ',O,C,D+1);}}';
          out.push(code);
        }
      }
    }
  }
  gen(nodes, []);
  let head = '';
  if (slots > 0) {
    const vs = [];
    const ls = [];
    for (let s = 0; s < slots; s++) { vs.push('$v' + s); ls.push('$l' + s); }
    head += 'let ' + vs.join(',') + ';let ' + ls.join(',') + ';';
  }
  for (let h = 0; h < free.length; h++) head += 'const $h' + h + '=C.l(F,V,' + JSON.stringify(free[h]) + ');';
  return new Function('V', 'F', 'O', 'C', 'D', head + out.join(''));
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

function hasScheme(t) {
  const c0 = t.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
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
    reading_minutes: (s.rm === undefined ? (s.rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200))) : s.rm),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s) {
  const p = cardOf(s);
  p.slug = s.slug;
  p.content = s.html;
  p.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  p.newer = linkOf(s.newer === undefined ? null : s.newer);
  p.older = linkOf(s.older === undefined ? null : s.older);
  p.is_post = s.post;
  return p;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(cmp);
  for (const name of names) {
    let nodes;
    try {
      nodes = parseTemplate(name, input.templates[name]);
    } catch (e) {
      if (!(e instanceof TErr)) throw e;
      report.push(e.message);
      continue;
    }
    templates.set(name, compileTemplate(nodes));
  }
  const ctx = { t: templates, e: esc, x: textOf, y: truthy, g: getProp, l: lookupFrame };
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((a, b) => cmp(a.path, b.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
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
    if (!templates.has(layout)) { report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses'); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push('draft ' + s.path); continue; }
    kept.push(s);
  }
  sources.length = 0;
  for (const s of kept) sources.push(s);
  // Permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    const slug = uniqueSlug(s.data.slug === undefined ? slugify(s.data.title, slugCache) : s.data.slug, set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }
  // Markdown, with links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (hasScheme(target) || target[0] === '/' || target[0] === '#') return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
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
  // One vars object per build, its per-render keys rewritten each call.
  // A key left undefined reads exactly as an absent key (lookup yields
  // undefined either way), so reusing it cannot change a render.
  const V = { site, tags: allTags, recent };
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    V.page = vars.page;
    V.posts = vars.posts;
    V.pager = vars.pager;
    V.tag = vars.tag;
    const O = [];
    fn(V, null, O, ctx, 0);
    return O.join('');
  };
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s) });
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
