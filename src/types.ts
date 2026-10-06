/** A data item in the underlying store. */
export interface Item {
  readonly id: string;
  readonly [key: string]: unknown;
}

/** Authorization policy: the concrete rule deciding item visibility. */
export interface Policy {
  readonly name: string;
  readonly allows: (item: Item) => boolean;
}

/**
 * Every published message is bound to a monotonically increasing version.
 * Versions start at 1 and increment by exactly 1 per message, so consumers
 * can detect gaps, duplicates and reordering.
 */
export type Message =
  | { readonly kind: 'add'; readonly version: number; readonly item: Item }
  | { readonly kind: 'delete'; readonly version: number; readonly id: string };

export type MessageListener = (message: Message) => void;
