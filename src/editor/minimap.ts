import { type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { layout, lineRuns, scrollTopForY, viewportRect, type Layout } from "../lib/minimapLayout";
import "../styles/minimap.css";

const WIDTH = 84;

class Minimap {
  private wrap: HTMLElement;
  private canvas: HTMLCanvasElement;
  private slider: HTMLElement;
  private lay: Layout = layout(0, 0);
  private raf = 0;
  private dragging = false;

  constructor(private view: EditorView) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cm-minimap-canvas";
    this.slider = document.createElement("div");
    this.slider.className = "cm-minimap-slider";
    this.wrap = document.createElement("div");
    this.wrap.className = "cm-minimap";
    this.wrap.setAttribute("aria-hidden", "true");
    this.wrap.append(this.canvas, this.slider);
    view.dom.append(this.wrap);
    this.wrap.addEventListener("pointerdown", (e) => this.onPointer(e));
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.schedule();
  }

  private onScroll = (): void => {
    this.placeSlider();
  };

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  update(u: ViewUpdate): void {
    if (u.docChanged || u.geometryChanged || u.viewportChanged) this.schedule();
    else this.placeSlider();
  }

  private ink(): string {
    return getComputedStyle(this.view.dom).getPropertyValue("--muted").trim() || "#888";
  }

  private draw(): void {
    const { doc } = this.view.state;
    const h = this.wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.lay = layout(doc.lines, h);
    this.canvas.width = WIDTH * dpr;
    this.canvas.height = Math.max(1, h) * dpr;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = this.ink();
    const { rowHeight, step } = this.lay;
    // Each character is about 0.9 px wide; blank gaps stay empty so code structure shows.
    for (let n = 1, row = 0; n <= doc.lines; n += step, row++) {
      const text = doc.line(n).text;
      for (const [a, b] of lineRuns(text)) ctx.fillRect(2 + a * 0.9, row * rowHeight, Math.max(1, (b - a) * 0.9), Math.max(1, rowHeight - (rowHeight > 1 ? 0.5 : 0)));
    }
    this.placeSlider();
  }

  private placeSlider(): void {
    const s = this.view.scrollDOM;
    const r = viewportRect(s.scrollTop, s.clientHeight, s.scrollHeight, this.lay);
    this.slider.style.top = `${r.top}px`;
    this.slider.style.height = `${r.height}px`;
  }

  private scrollToPointer(e: PointerEvent): void {
    const rect = this.wrap.getBoundingClientRect();
    const s = this.view.scrollDOM;
    s.scrollTop = scrollTopForY(e.clientY - rect.top, s.clientHeight, s.scrollHeight, this.lay);
  }

  private onPointer(e: PointerEvent): void {
    e.preventDefault();
    this.dragging = true;
    this.wrap.setPointerCapture(e.pointerId);
    this.scrollToPointer(e);
    const move = (ev: PointerEvent) => this.dragging && this.scrollToPointer(ev);
    const up = () => {
      this.dragging = false;
      this.wrap.removeEventListener("pointermove", move);
      this.wrap.removeEventListener("pointerup", up);
    };
    this.wrap.addEventListener("pointermove", move);
    this.wrap.addEventListener("pointerup", up);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.wrap.remove();
  }
}

/** A canvas minimap on the right edge of the editor, with a draggable viewport marker. Loaded on demand. */
export function minimap(): Extension {
  return [
    ViewPlugin.fromClass(Minimap),
    EditorView.theme({ ".cm-scroller": { marginRight: `${WIDTH}px` } }),
  ];
}
