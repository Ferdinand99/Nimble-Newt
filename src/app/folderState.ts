import { api } from "../lib/api";

/** The folder shown as a workspace (left sidebar), remembered between runs. */
export interface FolderState {
  root: string | null;
  expanded: string[];
  open: boolean;
  showHidden: boolean;
}

let state: FolderState = { root: null, expanded: [], open: false, showHidden: false };

export const folderState = (): FolderState => state;

export async function loadFolderState(): Promise<FolderState> {
  try {
    const raw = await api.docRead("workspace");
    const v = raw ? JSON.parse(raw) : {};
    state = {
      root: typeof v.root === "string" ? v.root : null,
      expanded: Array.isArray(v.expanded) ? v.expanded.filter((x: unknown): x is string => typeof x === "string").slice(0, 200) : [],
      open: v.open === true,
      showHidden: v.showHidden === true,
    };
  } catch {
    /* keep defaults */
  }
  return state;
}

export function saveFolderState(patch: Partial<FolderState>): void {
  state = { ...state, ...patch };
  void api.docWrite("workspace", JSON.stringify(state)).catch(() => {});
}
