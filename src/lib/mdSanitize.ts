// Sanitises the HTML of a rendered Markdown document before it is put in the page (DOMPurify).
//
// Removed: scripts, event handlers, styles (the `style` element and attribute), frames, objects,
// forms and their controls, media elements, SVG and MathML, `srcset` and other ways to load
// something, `target`, `tabindex` and the like. `id` and `name` get a `user-content-` prefix so they
// cannot clobber globals of the app. `class` keeps only the few names the renderer itself writes, so
// raw HTML cannot borrow the app's styles to cover the window.
//
// Links and images are marked for the view (data-md-*) instead of being left to the browser:
// - a link gets `data-md-link` = anchor | external | markdown | blocked, and `data-md-href` (anchor,
//   external) or `data-md-path` / `data-md-fragment` (markdown); blocked links lose their `href`;
// - an image keeps its `src` only for `data:image/…`; a remote image moves its URL to
//   `data-md-remote` and a relative one its path to `data-md-local`, both without `src`, so nothing
//   loads until the view asks the backend for it. Anything else loses its `src`.
// Attributes named `data-md-*` in the document itself are dropped, so the file cannot fake them.

import DOMPurify, { type Config, type DOMPurify as Purifier } from "dompurify";
import { classifyImage, classifyLink } from "./mdLinks";

export interface SanitizedMarkdown {
  fragment: DocumentFragment;
  /** Remote images that were held back (they need the user's consent). */
  remoteImages: number;
  /** Images next to the document, which the view loads through the backend. */
  localImages: number;
}

const FORBID_TAGS = [
  "script", "style", "link", "meta", "base", "title", "noscript", "template", "slot",
  "iframe", "frame", "frameset", "object", "embed", "applet", "portal", "fencedframe",
  "form", "button", "textarea", "select", "option", "optgroup", "datalist", "output", "fieldset", "keygen",
  "video", "audio", "source", "track", "picture", "canvas", "map", "area",
  "dialog", "marquee", "svg", "math",
];

const FORBID_ATTR = [
  "style", "srcset", "sizes", "background", "poster", "action", "formaction", "ping", "target",
  "autofocus", "tabindex", "contenteditable", "popover", "popovertarget", "popovertargetaction",
  "accesskey", "draggable", "inert", "usemap", "loading", "fetchpriority", "referrerpolicy", "crossorigin",
  "form", "formtarget", "srcdoc", "is", "nonce", "slot", "part", "exportparts",
];

/** The class names the renderer writes; nothing else survives. */
const CLASS_OK = /^(language-[\w+#.-]{1,40}|task-list-item|contains-task-list|task-list-item-checkbox|md-split-table|md-split-list)$/;

const CONFIG: Config & { RETURN_DOM_FRAGMENT: true } = {
  USE_PROFILES: { html: true },
  FORBID_TAGS,
  FORBID_ATTR,
  SANITIZE_NAMED_PROPS: true,
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  RETURN_DOM_FRAGMENT: true,
};

let purifier: Purifier | null = null;
let counts = { remote: 0, local: 0 };

function setUp(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook("uponSanitizeAttribute", (_node, data) => {
    const name = data.attrName;
    if (name.startsWith("data-md-")) {
      data.keepAttr = false;
    } else if (name === "class") {
      const kept = data.attrValue.split(/\s+/).filter((c) => CLASS_OK.test(c));
      if (kept.length) data.attrValue = kept.join(" ");
      else data.keepAttr = false;
    }
  });
  p.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof Element)) return;
    const tag = node.tagName;
    if (tag === "A") {
      if (!node.hasAttribute("href")) return;
      const target = classifyLink(node.getAttribute("href"));
      node.setAttribute("data-md-link", target.kind);
      if (target.kind === "blocked") node.removeAttribute("href");
      else if (target.kind === "anchor") node.setAttribute("data-md-href", target.id);
      else if (target.kind === "external") node.setAttribute("data-md-href", target.url);
      else {
        // Path and fragment apart: a "#" can be part of a file name.
        node.setAttribute("data-md-path", target.path);
        if (target.fragment) node.setAttribute("data-md-fragment", target.fragment);
      }
    } else if (tag === "IMG") {
      const source = classifyImage(node.getAttribute("src"));
      if (source.kind === "data") return;
      node.removeAttribute("src");
      if (source.kind === "remote") {
        node.setAttribute("data-md-remote", source.url);
        counts.remote++;
      } else if (source.kind === "local") {
        node.setAttribute("data-md-local", source.path);
        counts.local++;
      } else node.setAttribute("data-md-blocked", "");
    } else if (tag === "INPUT") {
      // Only the task-list checkbox exists in the view, and it cannot be changed.
      for (const a of ["name", "value", "list", "pattern", "placeholder"]) node.removeAttribute(a);
      node.setAttribute("type", "checkbox");
      node.setAttribute("disabled", "");
    }
  });
  purifier = p;
  return p;
}

export function sanitizeMarkdown(html: string): SanitizedMarkdown {
  const p = setUp();
  counts = { remote: 0, local: 0 };
  const fragment = p.sanitize(html, CONFIG);
  return { fragment, remoteImages: counts.remote, localImages: counts.local };
}
