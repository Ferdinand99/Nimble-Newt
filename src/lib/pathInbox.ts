/**
 * Collects file paths that arrive (as `open-paths` events) before the workspace can open them,
 * then hands them over, in order, once a handler is attached.
 */
export class PathInbox {
  private queue: string[] = [];
  private handler: ((paths: string[]) => void) | null = null;

  push(paths: string[]): void {
    if (!paths.length) return;
    if (this.handler) this.handler(paths);
    else this.queue.push(...paths);
  }

  attach(handler: (paths: string[]) => void): void {
    this.handler = handler;
    if (this.queue.length) handler(this.queue.splice(0));
  }
}
