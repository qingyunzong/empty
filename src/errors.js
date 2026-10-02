export class ProcessingError extends Error {
  constructor(type, message, seq) {
    super(message);
    this.name = 'ProcessingError';
    this.type = type;
    this.seq = seq;
  }
}

export class CrashError extends Error {
  constructor(afterInstruction) {
    super(`Simulated crash after bytecode instruction #${afterInstruction}`);
    this.name = 'CrashError';
    this.afterInstruction = afterInstruction;
  }
}
