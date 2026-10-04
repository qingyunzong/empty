export { lex, KEYWORDS, LexError } from "./lexer.js";
export type { Token, TokenKind } from "./lexer.js";
export { parse, ParseError } from "./parser.js";
export type { Program, Stmt, Expr, Block } from "./parser.js";
export { analyze, Scope } from "./scope.js";
export type { Analysis, Decl, DeclKind, Ref } from "./scope.js";
export { planRename, applyEdits } from "./rename.js";
export type { Edit, RenameResult } from "./rename.js";
