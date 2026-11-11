export interface IncomingMessage {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

export type MessageListener = (event: IncomingMessage) => void;
export type WindowChangeListener = () => void;

export interface WindowAdapter {
  getCurrentWindow(): unknown;
  addMessageListener(listener: MessageListener): void;
  removeMessageListener(listener: MessageListener): void;
  onWindowChange(listener: WindowChangeListener): void;
  postMessage(target: unknown, message: unknown, targetOrigin: string): void;
}

interface EventTargetLike {
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
}

interface RawMessageEvent {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

export interface IframeLike extends EventTargetLike {
  readonly contentWindow: unknown;
}

export class IframeWindowAdapter implements WindowAdapter {
  private readonly messageListeners = new Set<MessageListener>();
  private readonly changeListeners = new Set<WindowChangeListener>();

  private readonly domMessageListener = (event: RawMessageEvent): void => {
    const incoming: IncomingMessage = {
      origin: event.origin,
      source: event.source,
      data: event.data,
    };
    for (const listener of this.messageListeners) {
      listener(incoming);
    }
  };

  private readonly domLoadListener = (): void => {
    for (const listener of this.changeListeners) {
      listener();
    }
  };

  constructor(
    private readonly host: EventTargetLike,
    private readonly iframe: IframeLike,
  ) {
    this.host.addEventListener('message', this.domMessageListener as (event: never) => void);
    this.iframe.addEventListener('load', this.domLoadListener as (event: never) => void);
  }

  getCurrentWindow(): unknown {
    return this.iframe.contentWindow;
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
    (target as { postMessage(message: unknown, targetOrigin: string): void }).postMessage(
      message,
      targetOrigin,
    );
  }

  dispose(): void {
    this.host.removeEventListener('message', this.domMessageListener as (event: never) => void);
    this.iframe.removeEventListener('load', this.domLoadListener as (event: never) => void);
    this.messageListeners.clear();
    this.changeListeners.clear();
  }
}
