import type { IncomingMessage, MessageListener, WindowAdapter, WindowChangeListener } from '../src/adapter.js';
import type { RandomSource } from '../src/random.js';

export interface SentMessage {
  target: unknown;
  message: Record<string, unknown>;
  origin: string;
}

export class FakeWindowAdapter implements WindowAdapter {
  readonly windowA = { name: 'window-a' };
  readonly windowB = { name: 'window-b' };
  current: unknown = this.windowA;
  readonly sent: SentMessage[] = [];

  private readonly messageListeners = new Set<MessageListener>();
  private readonly changeListeners = new Set<WindowChangeListener>();

  getCurrentWindow(): unknown {
    return this.current;
  }

  addMessageListener(listener: MessageListener): void {
    this.messageListeners.add(listener);
  }

  removeMessageListener(listener: MessageListener): void {
    this.messageListeners.delete(listener);
  }

  onWindowChange(listener: WindowChangeListener): void {
    this.changeListeners.add(listener);
  }

  postMessage(target: unknown, message: unknown, targetOrigin: string): void {
    this.sent.push({ target, message: message as Record<string, unknown>, origin: targetOrigin });
  }

  emit(origin: string, source: unknown, data: unknown): void {
    const event: IncomingMessage = { origin, source, data };
    for (const listener of [...this.messageListeners]) {
      listener(event);
    }
  }

  navigate(next: unknown): void {
    this.current = next;
    for (const listener of [...this.changeListeners]) {
      listener();
    }
  }

  last(): SentMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  results(): Array<Record<string, unknown>> {
    return this.sent.filter((s) => s.message.kind === 'bridge.result').map((s) => s.message);
  }
}

export class SeededRandomSource implements RandomSource {
  private counter = 0;

  randomBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (this.counter + index) & 0xff;
    }
    this.counter += 1;
    return bytes;
  }
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
