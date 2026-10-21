// Light, always-loaded part of the extension system: the list of commands extensions contribute,
// so the palette can show them without loading the host.

export interface ExtCommand {
  /** `ext:<extension id>:<local id>` */
  id: string;
  title: string;
}

let commands: ExtCommand[] = [];
export const extensionCommands = (): readonly ExtCommand[] => commands;
export function setExtensionCommands(list: ExtCommand[]): void {
  commands = list;
}
export const isExtensionCommand = (id: string): boolean => id.startsWith("ext:");

export function splitCommandId(id: string): { ext: string; command: string } | null {
  const m = /^ext:([a-z0-9]+(?:\.[a-z0-9-]+)+):([A-Za-z][A-Za-z0-9_-]{0,39})$/.exec(id);
  return m ? { ext: m[1], command: m[2] } : null;
}
