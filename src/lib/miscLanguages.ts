import { StreamLanguage } from "@codemirror/language";

/** Makefile: comments, rules, variable assignments, $(...) references and directives. */
export const makefileLanguage = StreamLanguage.define<object>({
  startState: () => ({}),
  token(stream) {
    if (stream.sol() && stream.match(/^(?:include|-include|sinclude|ifn?eq|ifn?def|else|endif|define|endef|export|unexport|override|vpath|\.PHONY|\.DEFAULT|\.SUFFIXES)\b/)) return "keyword";
    if (stream.sol() && stream.match(/^[A-Za-z_][\w.-]*(?=\s*(?:[:?+]?=|::=))/)) return "variableName";
    if (stream.sol() && stream.match(/^[^\s:#=][^:#=]*(?=:(?!=))/)) return "typeName";
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return "comment";
    if (stream.match(/^\$[({][^)}]*[)}]/) || stream.match(/^\$[@<^?*%+|]/)) return "variableName";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return "string";
    if (stream.match(/^(?:[:?+]?=|::=|:)/)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
});

const GQL_KEYWORDS = /^(?:query|mutation|subscription|fragment|on|type|interface|union|enum|input|scalar|schema|extend|directive|implements|repeatable)\b/;

/** GraphQL schema and query documents. */
export const graphqlLanguage = StreamLanguage.define<{ block: boolean }>({
  startState: () => ({ block: false }),
  token(stream, state) {
    if (state.block) {
      if (stream.match(/^[\s\S]*?"""/)) state.block = false;
      else stream.skipToEnd();
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return "comment";
    if (stream.match('"""')) {
      state.block = true;
      return "string";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^[$@][A-Za-z_]\w*/)) return "variableName";
    if (stream.match(/^(?:true|false|null)\b/)) return "atom";
    if (stream.match(GQL_KEYWORDS)) return "keyword";
    if (stream.match(/^(?:Int|Float|String|Boolean|ID)\b/)) return "typeName";
    if (stream.match(/^[A-Z]\w*/)) return "typeName";
    if (stream.match(/^[A-Za-z_]\w*(?=\s*[:(])/)) return "propertyName";
    if (stream.match(/^[A-Za-z_]\w*/)) return null;
    if (stream.match(/^(?:\.\.\.|[!=|&:])/)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
});

const CSV_TOKENS = ["number", "string", "keyword", "typeName", "atom", "variableName"] as const;

function csvLanguage(sep: string) {
  return StreamLanguage.define<{ col: number; quoted: boolean }>({
    startState: () => ({ col: 0, quoted: false }),
    token(stream, state) {
      if (stream.sol() && !state.quoted) state.col = 0;
      const tok = CSV_TOKENS[state.col % CSV_TOKENS.length];
      if (state.quoted) {
        while (!stream.eol()) {
          if (stream.next() === '"') {
            if (stream.peek() === '"') stream.next();
            else {
              state.quoted = false;
              break;
            }
          }
        }
        return tok;
      }
      if (stream.peek() === sep) {
        stream.next();
        state.col++;
        return "punctuation";
      }
      if (stream.peek() === '"') {
        stream.next();
        state.quoted = true;
        return tok;
      }
      while (!stream.eol() && stream.peek() !== sep) stream.next();
      return tok;
    },
  });
}

/** Comma separated values: columns are coloured in rotation so they are easy to follow. */
export const csv = csvLanguage(",");
export const tsv = csvLanguage("\t");

/** .gitignore-style files: # comments, ! negations and glob characters. */
export const ignoreLanguage = StreamLanguage.define<object>({
  startState: () => ({}),
  token(stream) {
    if (stream.sol()) {
      if (stream.match(/^#.*/)) return "comment";
      if (stream.eat("!")) return "operator";
    }
    if (stream.match(/^[*?]+|^\[[^\]]*\]/)) return "keyword";
    if (stream.match(/^[^*?[!#]+/)) return null;
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
});
