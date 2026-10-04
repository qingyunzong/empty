import type { FileAdapter } from './types.js';

export class PowerLossError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowerLossError';
  }
}

// In-memory FileAdapter with fault injection. cutPowerAfter(n) lets the next
// n writes succeed and then takes the storage offline (every further write or
// delete throws PowerLossError) until restorePower() is called, simulating a
// power cut mid-migration. Reads always succeed so state can be inspected.
export class InMemoryFileAdapter implements FileAdapter {
  private readonly files: Map<string, string> = new Map();
  private writesBeforeOutage: number = -1;

  cutPowerAfter(writes: number): void {
    this.writesBeforeOutage = writes;
  }

  restorePower(): void {
    this.writesBeforeOutage = -1;
  }

  private checkPower(): void {
    if (this.writesBeforeOutage === 0) {
      throw new PowerLossError('simulated power loss: storage is offline');
    }
    if (this.writesBeforeOutage > 0) {
      this.writesBeforeOutage -= 1;
    }
  }

  read(path: string): string | null {
    const value = this.files.get(path);
    if (value === undefined) return null;
    return value;
  }

  write(path: string, data: string): void {
    this.checkPower();
    this.files.set(path, data);
  }

  delete(path: string): void {
    this.checkPower();
    this.files.delete(path);
  }

  has(path: string): boolean {
    return this.files.has(path);
  }
}
