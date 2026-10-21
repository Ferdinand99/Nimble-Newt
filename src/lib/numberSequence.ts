/**
 * Number sequences for column editing ("insert numbers"). Pure, no DOM.
 *
 * `sequence()` never throws: it sanitises its input (see `sanitizeSeq`) and clamps the count to MAX_SEQ_COUNT.
 * `parseSeqOptions()` is the strict variant for form input: it returns an error naming the offending field instead.
 * Arithmetic is done with BigInt so huge starts and steps stay exact. Negative values in non-decimal bases are
 * written with a minus sign ("-ff"), not as two's complement.
 */

export type SeqBase = 2 | 8 | 10 | 16;

export interface SeqOptions {
  start: number | bigint;
  step: number | bigint;
  /** Repeat each value this many times before advancing (>= 1). */
  repeat: number;
  base: SeqBase;
  /** Minimum width of the digits (sign included); shorter numbers are padded. */
  pad: number;
  padChar: "0" | " ";
  uppercaseHex: boolean;
  prefix: string;
  suffix: string;
}

export const MAX_SEQ_COUNT = 1_000_000;
export const MAX_SEQ_PAD = 64;
export const MAX_SEQ_REPEAT = 1_000_000;

export const defaultSeqOptions: SeqOptions = {
  start: 1,
  step: 1,
  repeat: 1,
  base: 10,
  pad: 0,
  padChar: "0",
  uppercaseHex: false,
  prefix: "",
  suffix: "",
};

function toBig(v: number | bigint, fallback: bigint): bigint {
  if (typeof v === "bigint") return v;
  return Number.isFinite(v) ? BigInt(Math.trunc(v)) : fallback;
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** Fills in defaults and clamps every field into its valid range. */
export function sanitizeSeq(o: Partial<SeqOptions> = {}): Required<Omit<SeqOptions, "start" | "step">> & { start: bigint; step: bigint } {
  const d = defaultSeqOptions;
  const base = o.base === 2 || o.base === 8 || o.base === 16 ? o.base : 10;
  return {
    start: toBig(o.start ?? d.start, 1n),
    step: toBig(o.step ?? d.step, 1n),
    repeat: clampInt(o.repeat ?? d.repeat, 1, MAX_SEQ_REPEAT, 1),
    base,
    pad: clampInt(o.pad ?? d.pad, 0, MAX_SEQ_PAD, 0),
    padChar: o.padChar === " " ? " " : "0",
    uppercaseHex: !!o.uppercaseHex,
    prefix: o.prefix ?? "",
    suffix: o.suffix ?? "",
  };
}

/** Formats one integer in `base` with minimum width `pad` (the minus sign counts towards the width). */
export function formatInt(n: number | bigint, base: SeqBase = 10, pad = 0, padChar: "0" | " " = "0", upper = false): string {
  const v = typeof n === "bigint" ? n : BigInt(Math.trunc(n));
  const neg = v < 0n;
  let digits = (neg ? -v : v).toString(base);
  if (upper) digits = digits.toUpperCase();
  if (padChar === "0") {
    const width = Math.max(0, pad - (neg ? 1 : 0));
    return (neg ? "-" : "") + digits.padStart(width, "0");
  }
  return (neg ? "-" + digits : digits).padStart(pad, " ");
}

/** `count` formatted values (count is floored and clamped to 0..MAX_SEQ_COUNT). */
export function sequence(count: number, options: Partial<SeqOptions> = {}): string[] {
  const n = clampInt(count, 0, MAX_SEQ_COUNT, 0);
  const o = sanitizeSeq(options);
  const out: string[] = new Array<string>(n);
  let value = o.start;
  let left = o.repeat;
  let text = "";
  let fresh = true;
  for (let i = 0; i < n; i++) {
    if (fresh) {
      text = o.prefix + formatInt(value, o.base, o.pad, o.padChar, o.uppercaseHex) + o.suffix;
      fresh = false;
    }
    out[i] = text;
    if (--left === 0) {
      left = o.repeat;
      value += o.step;
      fresh = true;
    }
  }
  return out;
}

export interface SeqForm {
  count?: string;
  start?: string;
  step?: string;
  repeat?: string;
  base?: string;
  pad?: string;
  padChar?: string;
  uppercaseHex?: boolean | string;
  prefix?: string;
  suffix?: string;
}

export type SeqField = "count" | "start" | "step" | "repeat" | "base" | "pad" | "padChar";
export type SeqParse = { ok: true; count: number; options: SeqOptions } | { ok: false; field: SeqField; error: "required" | "integer" | "range" };

const INT = /^[+-]?\d+$/;

/**
 * Validates form strings. Empty fields use the defaults, except `count` which is required.
 * `start` and `step` are decimal integers (any size); the others must be within their ranges.
 */
export function parseSeqOptions(form: SeqForm): SeqParse {
  const fail = (field: SeqField, error: "required" | "integer" | "range"): SeqParse => ({ ok: false, field, error });
  const get = (s: string | undefined) => (s ?? "").trim();

  const int = (field: SeqField, raw: string | undefined, def: bigint, min: bigint, max: bigint): bigint | SeqParse => {
    const s = get(raw);
    if (s === "") return def;
    if (!INT.test(s)) return fail(field, "integer");
    const v = BigInt(s);
    return v < min || v > max ? fail(field, "range") : v;
  };

  const countS = get(form.count);
  if (countS === "") return fail("count", "required");
  const count = int("count", countS, 0n, 1n, BigInt(MAX_SEQ_COUNT));
  if (typeof count !== "bigint") return count;
  const huge = 1n << 200n;
  const start = int("start", form.start, 1n, -huge, huge);
  if (typeof start !== "bigint") return start;
  const step = int("step", form.step, 1n, -huge, huge);
  if (typeof step !== "bigint") return step;
  const repeat = int("repeat", form.repeat, 1n, 1n, BigInt(MAX_SEQ_REPEAT));
  if (typeof repeat !== "bigint") return repeat;
  const pad = int("pad", form.pad, 0n, 0n, BigInt(MAX_SEQ_PAD));
  if (typeof pad !== "bigint") return pad;
  const baseS = get(form.base);
  const base = baseS === "" ? 10 : Number(baseS);
  if (!(base === 2 || base === 8 || base === 10 || base === 16)) return fail("base", INT.test(baseS) ? "range" : "integer");
  const pc = form.padChar === undefined || form.padChar === "" ? "0" : form.padChar === "0" || form.padChar === " " ? form.padChar : null;
  if (pc === null) return fail("padChar", "range");
  const up = form.uppercaseHex === true || form.uppercaseHex === "true";
  return {
    ok: true,
    count: Number(count),
    options: { start, step, repeat: Number(repeat), base, pad: Number(pad), padChar: pc, uppercaseHex: up, prefix: form.prefix ?? "", suffix: form.suffix ?? "" },
  };
}
