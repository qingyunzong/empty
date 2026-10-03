export const E_CYCLE = 'E_CYCLE';
export const E_TIME = 'E_TIME';
export const E_PROOF = 'E_PROOF';

export class GenealogyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GenealogyError';
    this.code = code;
  }
}
