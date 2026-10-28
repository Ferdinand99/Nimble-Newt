import { IFRAME_BOOTSTRAP, WORKER_BOOTSTRAP } from "./bootstrap";
import { buildSrcdoc, type SandboxTimes } from "./protocol";

/**
 * The document of an extension's sandbox, exactly as the app stages it: our iframe bootstrap, and the extension's
 * script behind the worker bootstrap as the source of the worker the iframe starts. The end-to-end check in e2e/
 * loads this same output (with shorter clocks).
 */
export const sandboxDocument = (extensionCode: string, times?: SandboxTimes): string =>
  buildSrcdoc(IFRAME_BOOTSTRAP, WORKER_BOOTSTRAP + "\n" + extensionCode, times);
