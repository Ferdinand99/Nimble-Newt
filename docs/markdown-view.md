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

Large files stay responsive: parsing runs in a background worker (stopped and restarted if one parse takes more than 5 seconds), the view only renders after you pause typing (longer pauses for longer files), and only the part of the document that changed is sanitised and replaced, in short steps. Large lists and tables are split between items and rows for this, so a 1 MB list or table behaves like any other document.

## Safety

A Markdown file can contain HTML, and a README downloaded from somewhere is not trusted. The rendered view is safe by default:

- **HTML is sanitised** with DOMPurify before it is shown. Scripts, event handlers (`onerror`, `onclick`, …), frames, objects, forms, media elements, SVG, MathML, `<style>` and `style` attributes, `<base>`, `<meta>` and `<link>` are removed. Class names are limited to the few the renderer writes, so the file cannot borrow the app's styles, and the pane contains its content (`contain: layout paint`). `id` and `name` get a `user-content-` prefix.
- **Remote images are not loaded** until you click **Show images** in the bar above the document and confirm in the dialog that follows. The dialog is shown by the app itself (not by the page), and the yes is kept for that document only, until the app quits. The app then downloads the images itself:
  - `https` only, also after redirects (at most 5), without user names in the URL;
  - public addresses only: every name is resolved by the app and addresses on this computer or the local network (loopback, private, link-local, shared/CGNAT, multicast, reserved, and the IPv6 equivalents including IPv4-mapped, NAT64 and 6to4) are dropped before connecting, so a name that points inward, or switches to an inward address, gets no request; the same check runs for every redirect. (NAT64 and 6to4 addresses are refused as a whole, so on an IPv6-only network that reaches IPv4 hosts through DNS64, images on IPv4-only hosts do not load.)
  - no proxy (a proxy would resolve names itself), no cookies, no `Referer`, a generic `User-Agent`;
  - image content types only, at most 16 MB each (also when the server sends no length), 20 seconds per image.
- **Local images** next to the document are shown, but only files inside the document's folder or below it. Paths that climb out (`../../secret.png`), absolute paths, drive letters and symbolic links or junctions that point outside are refused. Only documents that the app itself opened or saved can load images; unsaved documents show none.
- **Links** never navigate the window. `http`, `https` and `mailto` links open in the system browser or mail program (mail links only with `to`, `cc`, `bcc`, `subject` and `body`; never `attach`); links to other Markdown files open in a tab; `#anchors` scroll the view. Everything else (`javascript:`, `data:`, `file:`, other schemes, other local files, paths with `:`) is refused. Web links work in saved documents only.

### Content security policy

The policy of the app is unchanged (`img-src 'self' data:`, no remote connections from the webview). The rendered view does not load anything by itself: the backend reads local images and downloads remote ones after checking the request, and returns them as `data:` URLs, which the policy already allows. The policy stays the last line of defence: even HTML that got past the sanitiser could not load a remote image or run a script.

### Backend commands

The view uses four commands. Each takes the path of the document, and the backend refuses any path it did not open or save itself (and forgets it when the tab is closed):

| Command | What it does | Guard |
|---|---|---|
| `md_local_image` | Reads an image next to the document | Known document; file inside its folder; image type; 16 MB |
| `md_allow_remote` | Shows the app's own confirmation dialog | Known document; the answer is the user's, not the page's |
| `md_remote_image` | Downloads a remote image | Known document **and** a yes in that dialog; the download rules above |
| `open_external` | Opens a link in the system browser or mail program | Known document; `http`, `https`, `mailto` without attachments |

These give the webview a way to reach the network and other programs that the content security policy alone did not allow before. What limits it:

- The "known document" check keeps the view to the documents that are open. It is a consistency check, not a security boundary: a script running in the page (which the sanitiser and the policy are there to prevent) could first open any existing file with the editor's normal open command, which reads any file anyway, and so make it known.
- The real boundary for the network is the app's own dialog, which the page cannot answer. Nothing is downloaded without the user's yes for that document. After a yes, a script in the page could use that document to download any public `https` URL, until the tab is closed or the app quits; closing the tab drops the yes and the document's known state.
- Such a script could also open web links in the browser for an open document.
