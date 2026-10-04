export interface Item {
  id: string;
  [key: string]: unknown;
}

export interface Subject {
  id: string;
  roles?: string[];
}

export type Policy = (item: Item, subject: Subject) => boolean;

export interface MessageBase {
  version: number;
  generation: number;
  policyVersion: number;
}

export type Message =
  | (MessageBase & { kind: 'upsert'; item: Item })
  | (MessageBase & { kind: 'delete'; id: string });

export type MessageDraft =
  | { kind: 'upsert'; generation: number; policyVersion: number; item: Item }
  | { kind: 'delete'; generation: number; policyVersion: number; id: string };
