import { api, errorMessage, type LargeHit, type LargeOpened, type LargeQuery, type IndexStatus, type LineText } from "../lib/api";
import { debounce, h, icon } from "../lib/dom";
import { t } from "../lib/i18n";
import { clamp } from "../lib/logic";
import { LargeOps } from "../lib/largeOps";
import { toast } from "./toast";
import "../styles/largeview.css";

const PAGE = 200;
const MAX_PAGES = 120;
const MAX_CHARS = 5000;

export interface ViewerHooks {
  /** Called when the visible line, total or indexing progress changed. */
  onChange(): void;
}

/** Read-only, virtual-scrolling view of a file too big for the editor. All data comes from Rust in pages. */
export class LargeViewer {
  readonly el: HTMLElement;
  private viewport: HTMLElement;
  private lines: HTMLElement;
  private scroll: HTMLElement;
  private thumb: HTMLElement;
  private banner: HTMLElement;
  private findBar: HTMLElement;
  private findInput: HTMLInputElement;
  private count: HTMLElement;
  private top = 0;
  private rowH = 20;
  private rows = 30;
  private token = 0;
  private pages = new Map<number, Promise<{ lines: LineText[]; available: boolean }>>();
  private status: IndexStatus;
  private hit: LargeHit | null = null;
  private flags = { regex: false, caseSensitive: false, wholeWord: false };
  private pollTimer: number | undefined;
  private followTimer: number | undefined;
  private following = false;
  private destroyed = false;
  private ro: ResizeObserver;

  constructor(parent: HTMLElement, readonly opened: LargeOpened, private hooks: ViewerHooks) {
    this.status = opened.status;
    this.lines = h("div", { class: "lv-lines" });
    this.viewport = h("div", { class: "lv-viewport", tabIndex: 0, role: "document", "aria-label": t("large.viewport") }, this.lines);
    this.thumb = h("div", { class: "lv-thumb" });
    this.scroll = h("div", { class: "lv-scroll", "aria-hidden": "true" }, this.thumb);
    this.banner = h("div", { class: "lv-banner" });
    this.findInput = h("input", { class: "input", type: "text", placeholder: t("find.find"), "aria-label": t("find.find"), spellcheck: false });
    this.count = h("span", { class: "find-count", "aria-live": "polite" });
    this.findBar = this.buildFindBar();
    this.findBar.hidden = true;
    this.el = h("div", { class: "lv" }, this.findBar, h("div", { class: "lv-main" }, this.viewport, this.scroll), this.banner);
    parent.append(this.el);

    this.viewport.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.viewport.addEventListener("keydown", (e) => this.onKey(e));
    this.wireScrollbar();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.viewport);
    this.layout();
    this.poll();
  }

  // ---- state -----------------------------------------------------------------

  get totalLines(): number {
    const s = this.status;
    if (s.done && s.totalLines !== null) return s.totalLines;
    if (s.indexedBytes > 0 && s.indexedLines > 0) return Math.max(s.indexedLines, Math.round((s.indexedLines / s.indexedBytes) * s.size));
    return Math.max(this.rows, 1);
  }
  /** 1-based line shown at the top. */
  get topLine(): number {
    return Math.floor(this.top) + 1;
  }
  get done(): boolean {
    return this.status.done;
  }
  get progress(): number {
    return this.status.size ? Math.min(1, this.status.indexedBytes / this.status.size) : 1;
  }

  private polling = false;
  private poll = (): void => {
    if (this.destroyed || this.status.done || this.polling) return;
    this.polling = true;
    this.pollTimer = window.setTimeout(async () => {
      this.polling = false;
      try {
        this.status = await api.lfStatus(this.opened.id);
      } catch {
        return;
      }
      this.updateChrome();
      this.hooks.onChange();
      // Lines that were "not indexed yet" may be readable now.
      if (this.placeholderShown) void this.render();
      this.poll();
    }, 250);
  };
  private placeholderShown = false;

  // ---- layout and rendering ---------------------------------------------------

  private layout(): void {
    const probe = this.lines.firstElementChild as HTMLElement | null;
    if (probe && probe.offsetHeight > 4) this.rowH = probe.offsetHeight;
    this.rows = Math.max(1, Math.ceil(this.viewport.clientHeight / this.rowH) + 1);
    this.top = clamp(this.top, 0, this.maxTop());
    void this.render();
    this.updateChrome();
  }

  private maxTop(): number {
    return Math.max(0, this.totalLines - (this.rows - 1));
  }

  private page(n: number): Promise<{ lines: LineText[]; available: boolean }> {
    let p = this.pages.get(n);
    if (!p) {
      p = api.lfRead(this.opened.id, n * PAGE, PAGE, MAX_CHARS).then((c) => ({ lines: c.lines, available: c.available || c.lines.length > 0 }));
      p.then((r) => {
        // Pages that came back empty because indexing was behind must be asked again later.
        if (!r.available) this.pages.delete(n);
      }).catch(() => this.pages.delete(n));
      this.pages.set(n, p);
      if (this.pages.size > MAX_PAGES) this.pages.delete(this.pages.keys().next().value as number);
    }
    return p;
  }

  private async render(): Promise<void> {
    if (this.destroyed) return;
    const mine = ++this.token;
    const first = Math.floor(this.top);
    const last = first + this.rows;
    const p0 = Math.floor(first / PAGE);
    const p1 = Math.floor(last / PAGE);
    let got: { lines: LineText[]; available: boolean }[];
    try {
      got = await Promise.all(Array.from({ length: p1 - p0 + 1 }, (_, i) => this.page(p0 + i)));
    } catch (e) {
      if (mine === this.token) this.lines.replaceChildren(h("div", { class: "lv-placeholder" }, errorMessage(e)));
      return;
    }
    if (mine !== this.token || this.destroyed) return;
    const at = (n: number): LineText | undefined => {
      const pg = got[Math.floor(n / PAGE) - p0];
      return pg?.lines[n - Math.floor(n / PAGE) * PAGE];
    };
    const rows: Node[] = [];
    const digits = String(Math.max(this.totalLines, last)).length;
    this.placeholderShown = false;
    const knownEnd = this.status.done && this.status.totalLines !== null ? this.status.totalLines : Infinity;
    for (let n = first; n < last && n < knownEnd; n++) {
      const line = at(n);
      if (!line) {
        if (n === first && !got[0].available) {
          this.placeholderShown = true;
          rows.push(h("div", { class: "lv-placeholder" }, t("large.notIndexed", { pct: Math.round(this.progress * 100) })));
        }
        break;
      }
      rows.push(this.row(n, line, digits));
    }
    this.lines.replaceChildren(...rows);
    this.lines.style.transform = `translateY(${-(this.top - first) * this.rowH}px)`;
    const probe = this.lines.firstElementChild as HTMLElement | null;
    if (probe && probe.classList.contains("lv-row") && probe.offsetHeight > 4) this.rowH = probe.offsetHeight;
  }

  private highlightRe(): RegExp | null {
    const q = this.query();
    if (!q.pattern) return null;
    try {
      const src = q.regex ? q.pattern : q.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(q.wholeWord ? `\\b(?:${src})\\b` : src, q.caseSensitive ? "gu" : "giu");
    } catch {
      return null;
    }
  }

  private row(n: number, line: LineText, digits: number): HTMLElement {
    const re = this.highlightRe();
    const text = line.text;
    const kids: (Node | string)[] = [];
    if (re && text.length < 4000) {
      let last = 0;
      for (const m of text.matchAll(re)) {
        if (!m[0]) continue;
        const idx = m.index ?? 0;
        kids.push(text.slice(last, idx));
        const isCurrent = this.hit && this.hit.line === n && this.hit.column === idx;
        kids.push(h("mark", { class: isCurrent ? "lv-current" : "" }, m[0]));
        last = idx + m[0].length;
      }
      kids.push(text.slice(last));
    } else kids.push(text);
    if (line.truncated) kids.push(h("span", { class: "lv-cut" }, t("large.cut")));
    const level = /\b(FATAL|CRITICAL|SEVERE|ERROR)\b/.test(text) ? "lv-error" : /\b(WARN|WARNING)\b/.test(text) ? "lv-warn" : /\b(DEBUG|TRACE)\b/.test(text) ? "lv-debug" : "";
    return h("div", { class: `lv-row ${level}`.trim() }, h("span", { class: "lv-no", style: `min-width:${digits}ch` }, String(n + 1)), h("span", { class: "lv-text" }, ...kids));
  }

  private updateChrome(): void {
    const track = this.scroll.clientHeight || 1;
    const total = this.totalLines;
    const size = clamp((this.rows / Math.max(total, 1)) * track, 24, track);
    const range = Math.max(1, this.maxTop());
    this.thumb.style.height = `${size}px`;
    this.thumb.style.top = `${clamp(this.top / range, 0, 1) * (track - size)}px`;
    const s = this.status;
    this.banner.replaceChildren(
      h("span", {}, t("large.banner")),
      h("span", { class: "grow" }),
      h("span", {}, s.done ? t("large.lines", { n: total.toLocaleString() }) : t("large.indexing", { pct: Math.round(this.progress * 100), n: total.toLocaleString() })),
    );
  }

  // ---- scrolling ---------------------------------------------------------------

  scrollTo(top: number): void {
    const next = clamp(top, 0, this.maxTop());
    if (next === this.top) return;
    this.top = next;
    this.updateChrome();
    this.scheduleRender();
    this.hooks.onChange();
  }
  private scheduleRender = (() => {
    let raf = 0;
    return () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        void this.render();
      });
    };
  })();

  private onWheel(e: WheelEvent): void {
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // horizontal: native
    e.preventDefault();
    const lines = e.deltaMode === 1 ? e.deltaY : e.deltaMode === 2 ? e.deltaY * (this.rows - 1) : e.deltaY / this.rowH;
    this.scrollTo(this.top + lines);
  }

  private onKey(e: KeyboardEvent): void {
    const page = this.rows - 2;
    const map: Record<string, () => void> = {
      ArrowDown: () => this.scrollTo(this.top + 1),
      ArrowUp: () => this.scrollTo(this.top - 1),
      PageDown: () => this.scrollTo(this.top + page),
      PageUp: () => this.scrollTo(this.top - page),
      Home: () => e.ctrlKey || e.metaKey ? this.scrollTo(0) : (this.viewport.scrollLeft = 0),
      End: () => (e.ctrlKey || e.metaKey ? this.scrollTo(this.maxTop()) : undefined),
      " ": () => this.scrollTo(this.top + (e.shiftKey ? -page : page)),
    };
    const fn = map[e.key];
    if (fn && !e.altKey) {
      e.preventDefault();
      fn();
    }
  }

  private wireScrollbar(): void {
    const toTop = (clientY: number, grab: number) => {
      const r = this.scroll.getBoundingClientRect();
      const size = this.thumb.offsetHeight;
      const frac = clamp((clientY - r.top - grab) / Math.max(1, r.height - size), 0, 1);
      this.scrollTo(frac * this.maxTop());
    };
    this.scroll.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.scroll.setPointerCapture(e.pointerId);
      this.scroll.classList.add("dragging");
      const tr = this.thumb.getBoundingClientRect();
      const grab = e.target === this.thumb ? e.clientY - tr.top : tr.height / 2;
      toTop(e.clientY, grab);
      const move = (ev: PointerEvent) => toTop(ev.clientY, grab);
      const up = () => {
        this.scroll.classList.remove("dragging");
        this.scroll.removeEventListener("pointermove", move);
        this.scroll.removeEventListener("pointerup", up);
      };
      this.scroll.addEventListener("pointermove", move);
      this.scroll.addEventListener("pointerup", up);
    });
  }

  /** Scrolls so that 1-based `line` is near the top (a third of the way down). */
  goToLine(line: number): void {
    this.scrollTo(Math.max(0, line - 1 - Math.floor(this.rows / 3)));
    this.viewport.focus();
  }

  focus(): void {
    this.viewport.focus();
  }

  // ---- find -----------------------------------------------------------------------

  private query(): LargeQuery {
    return { pattern: this.findInput.value, ...this.flags };
  }

  private buildFindBar(): HTMLElement {
    const tog = (label: string, ic: string, key: keyof typeof this.flags) => {
      const b = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: label, "aria-label": label, "aria-pressed": "false" }, icon(ic));
      b.addEventListener("click", () => {
        this.flags[key] = !this.flags[key];
        b.setAttribute("aria-pressed", String(this.flags[key]));
        this.queryChanged();
      });
      return b;
    };
    const prev = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: `${t("find.previous")} (Shift+F3)`, "aria-label": t("find.previous"), onclick: () => void this.find("backward") }, icon("arrow-up"));
    const next = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", title: `${t("find.next")} (F3)`, "aria-label": t("find.next"), onclick: () => void this.find("forward") }, icon("arrow-down"));
    const close = h("button", { class: "btn btn-icon btn-plain btn-sm", type: "button", "aria-label": t("common.close"), onclick: () => this.hideFind() }, icon("x"));
    const bar = h("div", { class: "find", role: "search" }, h("div", { class: "find-row" }, this.findInput, tog(t("find.matchCase"), "case", "caseSensitive"), tog(t("find.wholeWord"), "word", "wholeWord"), tog(t("find.regex"), "regex", "regex"), this.count, prev, next, close));
    this.findInput.addEventListener("input", () => this.queryChanged());
    bar.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.hideFind();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void this.find(e.shiftKey ? "backward" : "forward");
      }
    });
    return bar;
  }

  showFind(): void {
    this.findBar.hidden = false;
    this.findInput.focus();
    this.findInput.select();
  }
  hideFind(): void {
    this.findBar.hidden = true;
    this.hit = null;
    api.lfCancel(this.opened.id).catch(() => {});
    this.ops.start("count"); // a count still running must not write into the hidden bar
    this.ops.start("search");
    void this.render();
    this.viewport.focus();
  }

  private readonly ops = new LargeOps();
  private readonly countSoon = debounce(async () => {
    const q = this.query();
    const { op: mine, stale } = this.ops.start("count");
    if (stale !== null) api.lfCancel(this.opened.id, stale).catch(() => {});
    if (!q.pattern) {
      this.ops.finish("count", mine);
      this.count.textContent = "";
      return;
    }
    this.count.textContent = t("large.counting");
    try {
      const n = await api.lfCount(this.opened.id, q, mine);
      if (this.ops.finish("count", mine)) this.count.textContent = n === 0 ? t("find.noResults") : t("find.results", { n: n.toLocaleString() });
    } catch (e) {
      if (this.ops.finish("count", mine)) this.count.textContent = errorMessage(e) === "cancelled" ? "" : t("find.invalid");
    }
  }, 350);

  private queryChanged(): void {
    this.hit = null;
    this.findInput.setAttribute("aria-invalid", "false");
    void this.render();
    this.countSoon();
  }

  /** Finds the next or previous match from the last hit (or the top of the view) and scrolls to it. */
  async find(dir: "forward" | "backward"): Promise<void> {
    const q = this.query();
    if (!q.pattern) return this.showFind();
    const from = this.hit
      ? { line: this.hit.line, column: dir === "forward" ? this.hit.column + Math.max(1, this.hit.length) : this.hit.column }
      : { line: Math.floor(this.top) + (dir === "forward" ? 0 : 0), column: 0 };
    const { op, stale } = this.ops.start("search");
    if (stale !== null) api.lfCancel(this.opened.id, stale).catch(() => {});
    this.count.textContent = t("large.searching");
    try {
      const hit = await api.lfSearch(this.opened.id, q, from, dir, op);
      if (!this.ops.finish("search", op)) return; // superseded by a newer search
      this.count.textContent = "";
      if (!hit) {
        this.hit = null;
        toast(t("find.noResults"), "info");
        void this.render();
        return;
      }
      if (hit.wrapped) toast(t("large.wrapped"), "info");
      this.hit = hit;
      const visible = hit.line >= this.top && hit.line < this.top + this.rows - 2;
      if (!visible) this.scrollTo(Math.max(0, hit.line - Math.floor(this.rows / 3)));
      void this.render();
      this.countSoon();
    } catch (e) {
      if (!this.ops.finish("search", op)) return;
      this.count.textContent = "";
      this.findInput.setAttribute("aria-invalid", "true");
      if (errorMessage(e) !== "cancelled") toast(errorMessage(e), "error");
    }
  }

  // ---- follow (tail -f) ----------------------------------------------------------------

  setFollow(on: boolean): void {
    this.following = on;
    window.clearInterval(this.followTimer);
    if (!on) return;
    this.scrollTo(this.maxTop());
    this.followTimer = window.setInterval(async () => {
      try {
        const before = this.status.size;
        this.status = await api.lfRefresh(this.opened.id);
        if (this.status.reset) {
          this.pages.clear();
          this.top = 0;
        } else if (this.status.size !== before) {
          // Pages near the end changed; drop them so they are read again.
          this.pages.clear();
        }
        if (!this.status.done) this.poll();
        if (this.following) this.top = this.maxTop();
        this.updateChrome();
        void this.render();
        this.hooks.onChange();
      } catch {
        /* the file may be briefly unavailable while it rotates */
      }
    }, 1000);
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.pollTimer);
    window.clearInterval(this.followTimer);
    this.ro.disconnect();
    api.lfClose(this.opened.id).catch(() => {});
    this.el.remove();
  }

  setVisible(v: boolean): void {
    this.el.hidden = !v;
    if (v) {
      this.layout();
      this.viewport.focus();
    }
  }
}
