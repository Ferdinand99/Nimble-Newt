import { listEncodings, type Encoding } from "../lib/api";
import { t } from "../lib/i18n";
import { quickPick } from "./palette";

/** Searchable list of every supported encoding; resolves `null` when cancelled. */
export async function pickEncoding(title: string, current?: Encoding): Promise<Encoding | null> {
  const list = await listEncodings();
  return quickPick(
    list.map((e) => ({ label: e.label, detail: e.group === "Unicode" ? t("enc.group.unicode") : t(`enc.group.${e.group}`), value: e.label })),
    title,
    { selected: current },
  );
}
