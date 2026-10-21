import { StreamLanguage } from "@codemirror/language";

const KEYWORDS = /^(?:if|else|for|in|do|goto|call|exit|set|setlocal|endlocal|echo|pause|rem|shift|start|not|exist|defined|errorlevel|equ|neq|lss|leq|gtr|geq|cd|chdir|copy|del|dir|md|mkdir|move|ren|rename|rd|rmdir|type|cls|title|pushd|popd|choice|findstr|find|xcopy|robocopy|taskkill|timeout)\b/i;

/** Windows batch files (.bat/.cmd): REM and :: comments, labels, %variables% and keywords. */
export const batchLanguage = StreamLanguage.define<object>({
  startState: () => ({}),
  token(stream) {
    if (stream.sol()) {
      stream.eatSpace();
      if (stream.match(/^(?:rem\b.*|::.*)/i)) return "comment";
      if (stream.match(/^:[^\s:][^\s]*/)) return "labelName";
      if (stream.match(/^@/)) return "operator";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^%(?:~?[0-9*]|[^%\s]+%)/) || stream.match(/^![^!\s]+!/)) return "variableName";
    if (stream.match(/^"[^"]*"?/)) return "string";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^(?:&&|\|\||[|&<>]+)/)) return "operator";
    if (stream.match(KEYWORDS)) return "keyword";
    if (stream.match(/^[A-Za-z_][\w.-]*/)) return null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "REM " } },
});
