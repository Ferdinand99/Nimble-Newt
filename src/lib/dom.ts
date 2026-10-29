type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; dataset?: Record<string, string> };

/** Properties that parse a string as markup: `h` never sets them. Build child nodes instead. */
const MARKUP_PROPS = new Set(["innerhtml", "outerhtml", "srcdoc"]);

/**
 * Builds an element. Props become properties or attributes, `on*` functions become listeners, and
 * children are appended as nodes or text, so a string is never parsed as HTML. `innerHTML`,
 * `outerHTML`, `srcdoc` and `on*` handlers given as strings are refused (they would run text as
 * markup or script): `h` throws instead of setting them.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    const lower = k.toLowerCase();
    if (MARKUP_PROPS.has(lower)) throw new Error(`h(): "${k}" would parse text as HTML; append nodes instead`);
    if (lower.startsWith("on") && typeof v !== "function") throw new Error(`h(): "${k}" must be a function, not text that would run as script`);
    if (k === "class") el.className = String(v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el && k !== "list") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function icon(name: string, cls = ""): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${cls}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

export function $(sel: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): ((...a: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: number | undefined;
  let pending: A | undefined;
  const run = () => {
    timer = undefined;
    if (pending) {
      const a = pending;
      pending = undefined;
      fn(...a);
    }
  };
  const d = ((...a: A) => {
    pending = a;
    if (timer !== undefined) clearTimeout(timer);
    timer = window.setTimeout(run, ms);
  }) as ((...a: A) => void) & { flush: () => void; cancel: () => void };
  d.flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    run();
  };
  d.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return d;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.userAgent);
