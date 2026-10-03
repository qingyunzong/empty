export class BizError extends Error {
  constructor(message) { super(message); this.name = 'BizError'; this.kind = 'business'; }
}
export class CorruptionError extends Error {
  constructor(message) { super(message); this.name = 'CorruptionError'; this.kind = 'corruption'; }
}
export class SimulatedCrash extends Error {
  constructor(message) { super(message); this.name = 'SimulatedCrash'; }
}
