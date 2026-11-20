# Markdown view

Markdown files (`.md`, `.markdown`, `.mdx`, or any tab whose language is set to Markdown) can be shown in three ways:

| View | What you see | How to get there |
|---|---|---|
| **Edit** | The editor only, as for any other file. | Status bar, or the palette command "Markdown: Edit View". |
| **Split** | The editor on the left, the rendered document on the right. The rendered side follows your typing and both sides scroll together. | Status bar, `Ctrl+K V` (`⌘K V` on macOS), or "Markdown: Toggle Split View". |
| **Read** | The rendered document only. There is no cursor and the text cannot be changed; commands that would change it are refused. | Status bar, `Ctrl+Shift+V` (`⌘⇧V`), or "Markdown: Toggle Read View". |

The switch (Edit | Split | Read) sits in the status bar and only appears for Markdown tabs. Each tab remembers its own view, and the session restores it after a restart. The shortcuts only act in Markdown tabs; in other tabs the keys work as before. Opening the editor's own split view switches the tab back to Edit, since both use the same space.

## What is rendered

CommonMark with the GitHub additions: tables, task lists (shown as checkboxes that cannot be ticked), strikethrough, and links for bare URLs. Headings get GitHub-style anchors, so `[see below](#installation)` works. Code blocks with a language (` ```rust `) are coloured with the editor's own grammars and theme. Images are shown as described below. Light and dark theme follow the app.

Not rendered yet: Mermaid diagrams, math, footnotes. There is no PDF export and no editing inside the rendered view.

Large files stay responsive: parsing runs in a background worker, the view only renders after you pause typing (longer pauses for longer files), and only the part of the document that changed is rebuilt.

## Safety

A Markdown file can contain HTML, and a README downloaded from somewhere is not trusted. The rendered view is safe by default:

- **HTML is sanitised** with DOMPurify before it is shown. Scripts, event handlers (`onerror`, `onclick`, …), frames, objects, forms, media elements, SVG, MathML, `<style>` and `style` attributes, `<base>`, `<meta>` and `<link>` are removed. Class names are limited to the few the renderer writes, so the file cannot borrow the app's styles, and the pane contains its content (`contain: layout paint`). `id` and `name` get a `user-content-` prefix.
- **Remote images are not loaded** until you click **Show images** in the bar above the document. The choice is for that document only and is not remembered after a restart. The app then downloads them itself (https only, public hosts only, image types only, at most 16 MB each).
- **Local images** next to the document are shown, but only files inside the document's folder or below it. Paths that climb out (`../../secret.png`), absolute paths, drive letters and symbolic links that point outside are refused. Unsaved documents show no local images.
- **Links** never navigate the window. `http`, `https` and `mailto` links open in the system browser or mail program; links to other Markdown files open in a tab; `#anchors` scroll the view. Everything else (`javascript:`, `data:`, `file:`, other schemes, other local files) is refused.

### Content security policy

The policy of the app is unchanged (`img-src 'self' data:`, no remote connections from the webview). The rendered view does not load anything by itself: the backend reads local images and downloads remote ones after checking the request (`md_local_image`, `md_remote_image`), and returns them as `data:` URLs, which the policy already allows. Links are opened by the backend (`open_external`), which accepts only `http`, `https` and `mailto`. The policy stays the last line of defence: even HTML that got past the sanitiser could not load a remote image or run a script.
