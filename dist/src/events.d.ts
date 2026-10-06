/**
 * Stream event model.
 *
 * Idle/active status is driven ONLY by explicit events (`idle` / `active`),
 * never inferred from wall-clock time. A `data` event arriving on an idle
 * partition also reactivates it, since arriving data is itself an explicit
 * signal that the partition is producing again.
 */
export type StreamEvent = {
    readonly kind: "data";
    readonly partition: string;
    readonly eventTime: number;
} | {
    readonly kind: "idle";
    readonly partition: string;
} | {
    readonly kind: "active";
    readonly partition: string;
};
export declare function data(partition: string, eventTime: number): StreamEvent;
export declare function idle(partition: string): StreamEvent;
export declare function active(partition: string): StreamEvent;
