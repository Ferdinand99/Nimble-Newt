// Text tools: format/minify JSON and XML, Base64, URL and HTML encoding, timestamps, UUIDs.
// Pure functions; the UI applies them to the selection or the whole document.

export type Result = { ok: true; text: string } | { ok: false; error: string };
const ok = (text: string): Result => ({ ok: true, text });
const fail = (error: string): Result => ({ ok: false, error });

// ---------------------------------------------------------------- JSON

type JsonToken = { t: "str" | "num" | "lit" | "punct"; s: string };

function* jsonTokens(text: string): Generator<JsonToken> {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if ("{}[],:".includes(c)) {
      yield { t: "punct", s: c };
      i++;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      yield { t: "str", s: text.slice(i, j + 1) };
      i = j + 1;
    } else {
      let j = i;
      while (j < n && !" \t\n\r{}[],:\"".includes(text[j])) j++;
      const s = text.slice(i, j);
      yield { t: /^-?\d/.test(s) ? "num" : "lit", s };
      i = j;
    }
  }
}

/** Validates with the real parser, so errors are the browser's own, with position information. */
function validateJson(text: string): string | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Pretty-prints JSON keeping key order and the exact number literals (no precision loss for big numbers). */
export function formatJson(text: string, indent: string | number = 2): Result {
  const err = validateJson(text);
  if (err) return fail(err);
  const unit = typeof indent === "number" ? " ".repeat(indent) : indent;
  const out: string[] = [];
  let depth = 0;
  let prev: JsonToken | null = null;
  const nl = () => "\n" + unit.repeat(depth);
  for (const tok of jsonTokens(text)) {
    if (tok.t === "punct") {
      if (tok.s === "{" || tok.s === "[") {
        // A container that is an array element starts on its own line; after a key's colon it stays put.
        if (prev?.t === "punct" && (prev.s === "[" || prev.s === ",")) out.push(nl());
        out.push(tok.s);
        depth++;
      } else if (tok.s === "}" || tok.s === "]") {
        depth--;
        // Empty containers stay on one line: {} and [].
        const open = tok.s === "}" ? "{" : "[";
        if (prev?.s === open && prev.t === "punct") out.push(tok.s);
        else out.push(nl() + tok.s);
      } else if (tok.s === ",") {
        out.push(",");
      } else {
        out.push(": ");
      }
    } else {
      const afterOpenOrComma = prev?.t === "punct" && (prev.s === "{" || prev.s === "[" || prev.s === ",");
      out.push((afterOpenOrComma ? nl() : "") + tok.s);
    }
    prev = tok;
  }
  return ok(out.join(""));
}

export function minifyJson(text: string): Result {
  const err = validateJson(text);
  if (err) return fail(err);
  const out: string[] = [];
  for (const tok of jsonTokens(text)) out.push(tok.s);
  return ok(out.join(""));
}

// ---------------------------------------------------------------- XML

type XmlToken = { k: "decl" | "comment" | "cdata" | "doctype" | "open" | "close" | "self" | "text"; s: string };

function xmlTokens(text: string): XmlToken[] {
  const out: XmlToken[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (text[i] !== "<") {
      const j = text.indexOf("<", i);
      const end = j < 0 ? n : j;
      out.push({ k: "text", s: text.slice(i, end) });
      i = end;
      continue;
    }
    const rest = text.slice(i, i + 12);
    let end: number;
    let kind: XmlToken["k"];
    if (rest.startsWith("<!--")) {
      end = text.indexOf("-->", i + 4);
      end = end < 0 ? n : end + 3;
      kind = "comment";
    } else if (rest.startsWith("<![CDATA[")) {
      end = text.indexOf("]]>", i + 9);
      end = end < 0 ? n : end + 3;
      kind = "cdata";
    } else if (rest.startsWith("<?")) {
      end = text.indexOf("?>", i + 2);
      end = end < 0 ? n : end + 2;
      kind = "decl";
    } else if (rest.startsWith("<!")) {
      // DOCTYPE, possibly with an internal subset in brackets.
      let depth = 0;
      let j = i + 2;
      while (j < n && !(text[j] === ">" && depth === 0)) {
        if (text[j] === "[") depth++;
        if (text[j] === "]") depth--;
        j++;
      }
      end = Math.min(n, j + 1);
      kind = "doctype";
    } else {
      let j = i + 1;
      let quote = "";
      while (j < n) {
        const c = text[j];
        if (quote) {
          if (c === quote) quote = "";
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") break;
        j++;
      }
      end = Math.min(n, j + 1);
      const s = text.slice(i, end);
      kind = s.startsWith("</") ? "close" : s.endsWith("/>") ? "self" : "open";
    }
    out.push({ k: kind, s: text.slice(i, end) });
    i = end;
  }
  return out;
}

/** Cheap well-formedness check: tags must nest and close. */
function xmlBalanced(tokens: XmlToken[]): string | null {
  const stack: string[] = [];
  const name = (s: string) => /^<\/?\s*([^\s/>]+)/.exec(s)?.[1] ?? "";
  for (const t of tokens) {
    if (t.k === "open") stack.push(name(t.s));
    else if (t.k === "close") {
      const top = stack.pop();
      if (top !== name(t.s)) return `Unexpected closing tag </${name(t.s)}>${top ? `, expected </${top}>` : ""}`;
    }
  }
  return stack.length ? `Unclosed tag <${stack[stack.length - 1]}>` : null;
}

export function formatXml(text: string, indent: string | number = 2): Result {
  const tokens = xmlTokens(text.trim());
  const bad = xmlBalanced(tokens);
  if (bad) return fail(bad);
  const unit = typeof indent === "number" ? " ".repeat(indent) : indent;
  const lines: string[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.k === "text") {
      if (t.s.trim()) lines.push(unit.repeat(depth) + t.s.trim().replace(/\s*\n\s*/g, " "));
      continue;
    }
    if (t.k === "close") {
      depth = Math.max(0, depth - 1);
      lines.push(unit.repeat(depth) + t.s);
      continue;
    }
    // <a>text</a> stays on one line.
    const next = tokens[i + 1];
    const after = tokens[i + 2];
    if (t.k === "open" && next?.k === "text" && after?.k === "close" && !next.s.includes("\n")) {
      lines.push(unit.repeat(depth) + t.s + next.s.trim() + after.s);
      i += 2;
      continue;
    }
    lines.push(unit.repeat(depth) + t.s);
    if (t.k === "open") depth++;
  }
  return ok(lines.join("\n"));
}

export function minifyXml(text: string): Result {
  const tokens = xmlTokens(text.trim());
  const bad = xmlBalanced(tokens);
  if (bad) return fail(bad);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.k === "text") {
      // Whitespace-only text between tags carries no meaning here; real text keeps single spaces.
      const v = t.s.replace(/\s+/g, " ");
      if (v.trim()) out.push(v);
    } else if (t.k !== "comment") out.push(t.s);
  }
  return ok(out.join(""));
}

// ---------------------------------------------------------------- Base64, URL, HTML, hex

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function base64Encode(text: string, urlSafe = false): string {
  const bytes = encoder.encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const b = btoa(bin);
  return urlSafe ? b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : b;
}

export function base64Decode(text: string): Result {
  const clean = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) return fail("Not valid Base64");
  try {
    const bin = atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return ok(decoder.decode(bytes));
  } catch {
    return fail("The decoded bytes are not valid UTF-8 text");
  }
}

export const urlEncode = (text: string): string => encodeURIComponent(text);
export function urlDecode(text: string): Result {
  try {
    return ok(decodeURIComponent(text.replace(/\+/g, " ")));
  } catch {
    return fail("Not a valid percent-encoded string");
  }
}

const HTML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const htmlEncode = (text: string): string => text.replace(/[&<>"']/g, (c) => HTML_ESC[c]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", euro: "€", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»", aelig: "æ", oslash: "ø", aring: "å", AElig: "Æ", Oslash: "Ø", Aring: "Å" };
export function htmlDecode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e] ?? m;
  });
}

export const hexEncode = (text: string): string => [...encoder.encode(text)].map((b) => b.toString(16).padStart(2, "0")).join("");
export function hexDecode(text: string): Result {
  const clean = text.replace(/[\s:]|0x/gi, "");
  if (!/^([0-9a-fA-F]{2})*$/.test(clean)) return fail("Not valid hexadecimal");
  try {
    return ok(decoder.decode(Uint8Array.from(clean.match(/../g) ?? [], (h) => parseInt(h, 16))));
  } catch {
    return fail("The bytes are not valid UTF-8 text");
  }
}

// ---------------------------------------------------------------- timestamps

export interface Moment {
  epochSeconds: number;
  epochMillis: number;
  iso: string;
  local: string;
  /** What the input was taken as. */
  interpreted: "seconds" | "milliseconds" | "text";
}

/** Reads "1700000000", "1700000000123" or a date string and describes it. Returns null when unreadable. */
export function parseMoment(input: string, timeZone?: string): Moment | null {
  const s = input.trim();
  if (!s) return null;
  let ms: number;
  let how: Moment["interpreted"];
  if (/^-?\d{1,10}(\.\d+)?$/.test(s)) {
    ms = Math.round(Number(s) * 1000);
    how = "seconds";
  } else if (/^-?\d{11,16}$/.test(s)) {
    ms = Number(s);
    how = "milliseconds";
  } else {
    ms = Date.parse(s);
    how = "text";
  }
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return null;
  const d = new Date(ms);
  const local = new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeStyle: "medium", timeZone }).format(d);
  return { epochSeconds: Math.floor(ms / 1000), epochMillis: ms, iso: d.toISOString(), local, interpreted: how };
}

// ---------------------------------------------------------------- UUIDs

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

export function uuidV4(rand: (n: number) => Uint8Array = randomBytes): string {
  const b = rand(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** UUID version 7: 48-bit Unix millisecond timestamp, then random bits; sorts by creation time. */
export function uuidV7(now: number = Date.now(), rand: (n: number) => Uint8Array = randomBytes): string {
  const b = rand(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
