/**
 * Scenario DSL shared by the snapshot interpreter and the real-bus runner.
 * A scenario describes a set of subscriptions; each subscription has a plan
 * of actions executed by its handler. The interpreter computes the expected
 * call trace and aggregated errors directly from the specification
 * semantics, and tests compare both against the real bus.
 */
export type Action =
  | { readonly do: "publish"; readonly topic: string }
  | { readonly do: "republish"; readonly maxDepth: number }
  | {
      readonly do: "subscribe";
      readonly as: string;
      readonly topic: string;
      readonly plan: readonly Action[];
    }
  | { readonly do: "unsubscribe"; readonly name: string }
  | { readonly do: "fail"; readonly message: string }
  | { readonly do: "yield"; readonly ticks: number };

export interface SubscriptionSpec {
  readonly name: string;
  readonly topic: string;
  readonly plan: readonly Action[];
}

export interface Scenario {
  readonly subscriptions: readonly SubscriptionSpec[];
  readonly rootTopic: string;
}
