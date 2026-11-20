// What a link or image in a Markdown document may do. Pure functions, used by the sanitiser (to mark
// elements) and by the view (to act on a click). The backend checks the same things again before it
// reads a file, downloads an image or opens a URL.

export type LinkTarget =
  /** `#heading`: scrolls inside the rendered document. */
  | { kind: "anchor"; id: string }
  /** http, https and mailto: opened by the system browser or mail program. */
  | { kind: "external"; url: string }
  /** A relative link to another Markdown file: opened in a tab. `path` is still relative to the document. */
  | { kind: "markdown"; path: string; fragment: string }
  /** Anything else (`javascript:`, `data:`, `file:`, other files, other schemes): not followed. */
  | { kind: "blocked" };

export type ImageSource =
  | { kind: "data"; src: string }
  | { kind: "remote"; url: string }
  | { kind: "local"; path: string }
  | { kind: "blocked" };

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|svg\+xml)[;,]/i;

/** Browsers drop tabs and newlines anywhere in a URL ("java\nscript:") and control characters at its ends; so do we. */
function clean(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function splitFragment(s: string): { path: string; fragment: string } {
  const hash = s.indexOf("#");
  const beforeHash = hash >= 0 ? s.slice(0, hash) : s;
  const q = beforeHash.indexOf("?");
  return { path: q >= 0 ? beforeHash.slice(0, q) : beforeHash, fragment: hash >= 0 ? s.slice(hash + 1) : "" };
}

export function classifyLink(raw: string | null | undefined): LinkTarget {
  if (raw === null || raw === undefined) return { kind: "blocked" };
  const href = clean(raw);
  if (!href) return { kind: "blocked" };
  if (href.startsWith("#")) {
    const id = decode(href.slice(1));
    return id === null ? { kind: "blocked" } : { kind: "anchor", id };
  }
  if (href.startsWith("//")) return { kind: "external", url: `https:${href}` };
  const scheme = SCHEME.exec(href)?.[1].toLowerCase();
  if (scheme) {
    // A single letter is a Windows drive ("C:\notes.md"): an absolute path, not followed.
    if (scheme === "http" || scheme === "https" || scheme === "mailto") return { kind: "external", url: href };
    return { kind: "blocked" };
  }
  const { path, fragment } = splitFragment(href);
  const decoded = decode(path);
  if (decoded === null || !decoded || decoded.includes("\0")) return { kind: "blocked" };
  if (/^[\\/]/.test(decoded)) return { kind: "blocked" };
  if (!MARKDOWN_EXT.test(decoded)) return { kind: "blocked" };
  return { kind: "markdown", path: decoded, fragment: decode(fragment) ?? "" };
}

export function classifyImage(raw: string | null | undefined): ImageSource {
  if (raw === null || raw === undefined) return { kind: "blocked" };
  const src = clean(raw);
  if (!src) return { kind: "blocked" };
  if (DATA_IMAGE.test(src)) return { kind: "data", src };
  if (src.startsWith("//")) return { kind: "remote", url: `https:${src}` };
  const scheme = SCHEME.exec(src)?.[1].toLowerCase();
  if (scheme) return scheme === "http" || scheme === "https" ? { kind: "remote", url: src } : { kind: "blocked" };
  const { path } = splitFragment(src);
  const decoded = decode(path);
  if (!decoded || decoded.includes("\0") || /^[\\/]/.test(decoded)) return { kind: "blocked" };
  return { kind: "local", path: decoded };
}

/**
 * Joins a relative link to the folder of `docPath`, folding `.` and `..`. The separator of the
 * document path is kept. Returns null when `..` would climb above the root of the path.
 */
export function resolveRelative(docPath: string, rel: string): string | null {
  const sep = docPath.includes("\\") && !docPath.includes("/") ? "\\" : "/";
  const parts = docPath.split(/[\\/]/);
  parts.pop(); // the file name
  const root = parts.length ? parts[0] : "";
  const stack = parts.slice(1);
  for (const seg of rel.split(/[\\/]/)) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!stack.length) return null;
      stack.pop();
    } else stack.push(seg);
  }
  return [root, ...stack].join(sep);
}

/** The id a heading gets (GitHub style): lower case, punctuation dropped, spaces to dashes. */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
