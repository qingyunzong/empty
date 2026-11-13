export class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class BridgeTimeoutError extends BridgeError {}

export class BridgeNavigationError extends BridgeError {}

export class BridgeDestroyedError extends BridgeError {}
