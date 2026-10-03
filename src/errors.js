export class DslError extends Error {
  constructor(code, message, pos = null) {
    super(message);
    this.name = 'DslError';
    this.code = code;
    this.pos = pos;
  }
}

export const E_PARSE = 'E_PARSE';     // lexer / grammar errors
export const E_SIGN = 'E_SIGN';       // static type errors: direction/asset-class/negative literal
export const E_VERSION = 'E_VERSION'; // version-graph / scope violations
export const E_NEG = 'E_NEG';         // freeze would go negative or exceed holdings
export const E_SEQ = 'E_SEQ';         // sequence replay / ordering violations
