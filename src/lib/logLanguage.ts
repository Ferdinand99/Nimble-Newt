import { StreamLanguage } from "@codemirror/language";

/** Minimal highlighter for log files: timestamps, levels, quoted strings and numbers. */
export const logLanguage = StreamLanguage.define<{ lineStart: boolean }>({
  startState: () => ({ lineStart: true }),
  token(stream, state) {
    if (stream.sol()) state.lineStart = true;
    if (stream.eatSpace()) return null;
    if (stream.match(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/) || stream.match(/^\d{2}:\d{2}:\d{2}(?:[.,]\d+)?/)) return "number";
    if (stream.match(/^\b(?:FATAL|CRITICAL|ERROR|ERR|SEVERE)\b/i)) return "invalid";
    if (stream.match(/^\b(?:WARN|WARNING)\b/i)) return "keyword";
    if (stream.match(/^\b(?:INFO|NOTICE)\b/i)) return "string";
    if (stream.match(/^\b(?:DEBUG|TRACE|VERBOSE)\b/i)) return "comment";
    if (stream.match(/^"(?:[^"\\]|\\.)*"/) || stream.match(/^'(?:[^'\\]|\\.)*'/)) return "string";
    if (stream.match(/^\[[^\]]*\]/)) return "typeName";
    if (stream.match(/^0x[0-9a-f]+/i) || stream.match(/^\b\d+(?:\.\d+)?\b/)) return "number";
    stream.next();
    return null;
  },
});
