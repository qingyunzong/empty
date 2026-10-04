export { lex, isIdentifierName, KEYWORDS } from "./lexer.js";
export { parse } from "./parser.js";
export { bind } from "./binder.js";
export type { BindResult, Decl, Ref, Scope } from "./binder.js";
export { planRename, applyEdits } from "./rename.js";
export type {
  Edit,
  RenameResult,
  RenameSuccess,
  RenameFailure,
  RenameErrorCode,
} from "./rename.js";
