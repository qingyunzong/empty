import type { ControlledExecutor } from './executor';
import type { Item, Policy, Subject } from './types';

/** Asynchronous authorization: every check is queued on the executor. */
export class AsyncAuthorizer {
  constructor(private readonly executor: ControlledExecutor) {}

  check(policy: Policy, item: Item, subject: Subject): Promise<boolean> {
    return this.executor.submit(() => policy(item, subject));
  }
}

/** Synchronous authorization: ground truth used to cross-check the async path. */
export function visibleSync(policy: Policy, items: Item[], subject: Subject): Item[] {
  return items.filter((item) => policy(item, subject));
}
