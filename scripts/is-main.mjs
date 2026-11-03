// True when the module that asks is the script node was started with. Both paths are resolved
// through links first: import.meta.url is a real path, process.argv[1] is not, so a checkout that
// is reached through a symlink or a junction would otherwise run nothing and still exit 0.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}
