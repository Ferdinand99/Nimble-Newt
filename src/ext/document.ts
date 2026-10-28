import { IFRAME_BOOTSTRAP, WORKER_BOOTSTRAP } from "./bootstrap";
import { buildSrcdoc } from "./protocol";

/**
 * The document of an extension's sandbox, exactly as the app stages it: our iframe bootstrap, and the extension's
 * script behind the worker bootstrap as the source of the worker the iframe starts. The end-to-end check in e2e/
 * loads this same output.
 */
export const sandboxDocument = (extensionCode: string, commandTimeoutMs?: number): string =>
  buildSrcdoc(IFRAME_BOOTSTRAP, WORKER_BOOTSTRAP + "\n" + extensionCode, commandTimeoutMs);
