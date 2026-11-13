export interface WindowLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface MessageEventLike {
  origin: string;
  source: WindowLike | null;
  data: unknown;
}

export type MessageListener = (event: MessageEventLike) => void;

export interface EventTargetLike {
  addEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
}

export interface LoadEventTargetLike {
  addEventListener(type: 'load', listener: () => void): void;
  removeEventListener(type: 'load', listener: () => void): void;
}
