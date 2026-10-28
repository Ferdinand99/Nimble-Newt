// The message protocol between the app and a sandboxed extension. Pure and tested: the host
// refuses anything that does not pass these checks.

export type Permission = "editor.read" | "editor.write" | "ui" | "clipboard.write" | "storage";
export const PERMISSIONS: Permission[] = ["editor.read", "editor.write", "ui", "clipboard.write", "storage"];

export const LIMITS = {
  textBytes: 4 * 1024 * 1024,
  messageChars: 500,
  items: 200,
  itemChars: 100,
  keyChars: 100,
  valueChars: 64 * 1024,
  callsPerSecond: 200,
  commandTimeoutMs: 10_000,
  /** The sandbox iframe owns the command timeout; the app's own clock runs this much longer, as a backstop. */
  commandBackstopMs: 2_000,
  startTimeoutMs: 5_000,
} as const;

/** Which permission a method needs; `null` means no permission is needed. Unknown methods are not listed. */
export const METHOD_PERMISSION: Record<string, Permission | null> = {
  "commands.register": null,
  "editor.getText": "editor.read",
  "editor.getSelection": "editor.read",
  "editor.getLanguage": "editor.read",
  "editor.getFileName": "editor.read",
  "editor.replaceSelection": "editor.write",
  "editor.replaceAll": "editor.write",
  "editor.insertText": "editor.write",
  "ui.message": "ui",
  "ui.prompt": "ui",
  "ui.pick": "ui",
  "clipboard.writeText": "clipboard.write",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.remove": "storage",
};

export interface Request {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export type Checked = { ok: true; req: Request } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Validates the shape of an incoming message and the arguments of the method it names. */
export function checkRequest(data: unknown, granted: readonly Permission[]): Checked {
  if (!isObj(data) || typeof data.method !== "string" || !Number.isSafeInteger(data.id)) return { ok: false, error: "malformed message" };
  const id = data.id as number;
  const method = data.method;
  const params = isObj(data.params) ? data.params : {};
  if (!(method in METHOD_PERMISSION)) return { ok: false, error: `unknown method ${method.slice(0, 40)}` };
  const need = METHOD_PERMISSION[method];
  if (need && !granted.includes(need)) return { ok: false, error: `permission "${need}" is required for ${method}` };
  const str = (k: string, max: number, required = true): string | null => {
    const v = params[k];
    if (v === undefined && !required) return null;
    if (typeof v !== "string") throw new Error(`${k} must be a string`);
    if (v.length > max) throw new Error(`${k} is too long`);
    return v;
  };
  try {
    switch (method) {
      case "commands.register":
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(str("id", 40) ?? "")) throw new Error("invalid command id");
        break;
      case "editor.replaceSelection":
      case "editor.replaceAll":
      case "editor.insertText":
        if (bytes(str("text", LIMITS.textBytes)!) > LIMITS.textBytes) throw new Error("text is too large");
        break;
      case "ui.message":
        str("text", LIMITS.messageChars);
        if (params.kind !== undefined && !["info", "success", "warning", "error"].includes(params.kind as string)) throw new Error("invalid kind");
        break;
      case "ui.prompt":
        str("title", LIMITS.itemChars);
        str("placeholder", LIMITS.itemChars, false);
        str("value", LIMITS.valueChars, false);
        break;
      case "ui.pick": {
        str("title", LIMITS.itemChars);
        const items = params.items;
        if (!Array.isArray(items) || items.length === 0 || items.length > LIMITS.items) throw new Error("items must be a list of 1-200 strings");
        if (!items.every((i) => typeof i === "string" && i.length <= LIMITS.itemChars)) throw new Error("every item must be a short string");
        break;
      }
      case "clipboard.writeText":
        if (bytes(str("text", LIMITS.textBytes)!) > LIMITS.textBytes) throw new Error("text is too large");
        break;
      case "storage.get":
      case "storage.remove":
        str("key", LIMITS.keyChars);
        break;
      case "storage.set":
        str("key", LIMITS.keyChars);
        str("value", LIMITS.valueChars);
        break;
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, req: { id, method, params } };
}

/** Sliding-window limiter: at most `max` calls in any `windowMs`. */
export class RateLimiter {
  private times: number[] = [];
  constructor(private max: number = LIMITS.callsPerSecond, private windowMs: number = 1000) {}
  allow(now = Date.now()): boolean {
    while (this.times.length && now - this.times[0] >= this.windowMs) this.times.shift();
    if (this.times.length >= this.max) return false;
    this.times.push(now);
    return true;
  }
}

/** Escapes script text for embedding in an inline <script> element of an HTML document. */
export function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/**
 * The policy of every sandbox document, as the `nnext` scheme header (src-tauri/src/sandbox.rs, kept equal by a test)
 * and as a meta tag in the document itself. Nothing is opened except inline script and blob workers: no connect-src,
 * frame-src or img-src, so the sandbox cannot load or send anything. A blob worker inherits this policy.
 */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; worker-src blob:";

/** A JSON string that is safe inside an inline <script>: `<` never appears literally, so no tag or comment can start. */
const jsonForScript = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");

/**
 * The document of an extension's sandbox: the policy, then our iframe bootstrap. The extension's script is not run in
 * the document at all; it travels as a string (`workerSource`: worker bootstrap + extension script) and the iframe
 * bootstrap starts it in a blob worker.
 */
export function buildSrcdoc(iframeBootstrap: string, workerSource: string, commandTimeoutMs: number = LIMITS.commandTimeoutMs): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`,
    `</head><body><script>var NN_WORKER_SOURCE=${jsonForScript(workerSource)};var NN_COMMAND_TIMEOUT_MS=${Math.trunc(commandTimeoutMs)};</script>`,
    `<script>${escapeInlineScript(iframeBootstrap)}</script></body></html>`,
  ].join("");
}
