export type MessageKind = "stdout" | "assertion" | "exit";

export interface BaseMessage {
  /** Unique, citable identifier, e.g. "r1:stdout:3". */
  readonly messageId: string;
  /** Round the message was produced in — attribution never changes. */
  readonly roundId: string;
  /** Generation number of the producing round. */
  readonly generation: number;
  /** Per-handle sequence number. */
  readonly seq: number;
  readonly kind: MessageKind;
}

export interface StdoutMessage extends BaseMessage {
  readonly kind: "stdout";
  readonly chunk: string;
  /** True on the final chunk: marks the stream as drained. */
  readonly final: boolean;
}

export interface AssertionMessage extends BaseMessage {
  readonly kind: "assertion";
  readonly name: string;
  readonly passed: boolean;
  readonly detail?: string;
}

export interface ExitMessage extends BaseMessage {
  readonly kind: "exit";
  readonly code: number;
  readonly signal: string | null;
}

export type RoundMessage = StdoutMessage | AssertionMessage | ExitMessage;
