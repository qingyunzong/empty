export type BudgetScope = 'workflow' | 'family' | 'instance';

export interface ErrorClassification {
  category: string;
  consumesBudget: boolean;
  retryable: boolean;
  reason: string;
}

export type ErrorClassifier = (error: unknown) => ErrorClassification;

export interface RuleEvidence {
  rule: string;
  outcome: string;
}

export interface RetryDecision {
  allowed: boolean;
  consumed: boolean;
  remaining: number;
  limit: number;
  category: string;
  scope: BudgetScope;
  budgetName: string;
  evidence: RuleEvidence[];
}

export interface BudgetOptions {
  scope: BudgetScope;
  name: string;
  limit: number;
  classifier?: ErrorClassifier;
}

interface BudgetState {
  scope: BudgetScope;
  name: string;
  limit: number;
  remaining: number;
}

const DEFAULT_CATEGORY = {
  cancelled: { consumesBudget: false, retryable: false },
  permanent: { consumesBudget: false, retryable: false },
  transient: { consumesBudget: true, retryable: true },
  'rate-limited': { consumesBudget: true, retryable: true },
  unknown: { consumesBudget: true, retryable: true },
} as const;

type DefaultCategory = keyof typeof DEFAULT_CATEGORY;

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name: unknown }).name);
  }
  return '';
}

function hasFlag(error: unknown, flag: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    flag in error &&
    Boolean((error as Record<string, unknown>)[flag])
  );
}

function httpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = Number((error as { status: unknown }).status);
    return Number.isFinite(status) ? status : undefined;
  }
  return undefined;
}

export const defaultClassifier: ErrorClassifier = (error) => {
  let category: DefaultCategory = 'unknown';
  let reason = 'unrecognized error shape';

  if (
    errorName(error) === 'AbortError' ||
    errorName(error) === 'CancelledError' ||
    hasFlag(error, 'cancelled')
  ) {
    category = 'cancelled';
    reason = 'cancellation is operator-initiated, not a failure';
  } else if (hasFlag(error, 'permanent')) {
    category = 'permanent';
    reason = 'error flagged as permanent';
  } else {
    const status = httpStatus(error);
    if (status === 429) {
      category = 'rate-limited';
      reason = 'HTTP 429';
    } else if (status !== undefined && status >= 400 && status < 500) {
      category = 'permanent';
      reason = `HTTP ${status} is a client error`;
    } else if (status !== undefined && status >= 500) {
      category = 'transient';
      reason = `HTTP ${status} is a server error`;
    } else if (error instanceof Error) {
      category = 'transient';
      reason = 'generic Error treated as transient';
    }
  }

  const policy = DEFAULT_CATEGORY[category];
  return { category, consumesBudget: policy.consumesBudget, retryable: policy.retryable, reason };
};

export class RetryBudget {
  readonly #state: BudgetState;
  readonly #classifier: ErrorClassifier;
  readonly #lineage: readonly string[];

  private constructor(state: BudgetState, classifier: ErrorClassifier, lineage: readonly string[]) {
    this.#state = state;
    this.#classifier = classifier;
    this.#lineage = lineage;
  }

  static create(options: BudgetOptions): RetryBudget {
    if (!Number.isInteger(options.limit) || options.limit < 0) {
      throw new RangeError(`budget limit must be a non-negative integer, got ${options.limit}`);
    }
    const state: BudgetState = {
      scope: options.scope,
      name: options.name,
      limit: options.limit,
      remaining: options.limit,
    };
    return new RetryBudget(state, options.classifier ?? defaultClassifier, [
      `${options.scope}:${options.name}`,
    ]);
  }

  get scope(): BudgetScope {
    return this.#state.scope;
  }

  get name(): string {
    return this.#state.name;
  }

  get limit(): number {
    return this.#state.limit;
  }

  get remaining(): number {
    return this.#state.remaining;
  }

  get lineage(): readonly string[] {
    return this.#lineage;
  }

  fork(label: string): RetryBudget {
    return new RetryBudget(this.#state, this.#classifier, [...this.#lineage, `subtask:${label}`]);
  }

  recordFailure(error: unknown): RetryDecision {
    const classification = this.#classifier(error);
    const evidence: RuleEvidence[] = [
      {
        rule: 'budget-scope',
        outcome: `${this.#state.scope}:${this.#state.name} (lineage: ${this.#lineage.join(' > ')})`,
      },
      {
        rule: `classify:${classification.category}`,
        outcome: classification.reason,
      },
    ];

    if (!classification.retryable) {
      evidence.push({
        rule: 'retryable:false',
        outcome: 'no retry permitted; budget untouched',
      });
      return this.#decision(false, false, classification.category, evidence);
    }

    if (!classification.consumesBudget) {
      evidence.push({
        rule: 'consume:false',
        outcome: 'category retries without spending budget',
      });
      return this.#decision(true, false, classification.category, evidence);
    }

    // Synchronous check-and-decrement: concurrent failures in the same tick
    // serialize here, so the final slot can be granted exactly once.
    if (this.#state.remaining <= 0) {
      evidence.push({
        rule: 'budget-exhausted',
        outcome: `remaining 0/${this.#state.limit}`,
      });
      return this.#decision(false, false, classification.category, evidence);
    }

    this.#state.remaining -= 1;
    evidence.push({
      rule: 'consume:true',
      outcome: `spent 1 slot, remaining ${this.#state.remaining}/${this.#state.limit}`,
    });
    return this.#decision(true, true, classification.category, evidence);
  }

  #decision(
    allowed: boolean,
    consumed: boolean,
    category: string,
    evidence: RuleEvidence[],
  ): RetryDecision {
    return {
      allowed,
      consumed,
      remaining: this.#state.remaining,
      limit: this.#state.limit,
      category,
      scope: this.#state.scope,
      budgetName: this.#state.name,
      evidence,
    };
  }
}

export interface TaskRef {
  workflowId: string;
  family?: string;
  instanceId?: string;
}

export interface ResolvedBudget {
  budget: RetryBudget;
  evidence: RuleEvidence[];
}

export class RetryBudgetRegistry {
  readonly #budgets = new Map<string, RetryBudget>();
  readonly #classifier?: ErrorClassifier;

  constructor(options?: { classifier?: ErrorClassifier }) {
    this.#classifier = options?.classifier;
  }

  setBudget(scope: BudgetScope, key: string, limit: number): RetryBudget {
    const budget = RetryBudget.create({
      scope,
      name: key,
      limit,
      classifier: this.#classifier,
    });
    this.#budgets.set(`${scope}:${key}`, budget);
    return budget;
  }

  setWorkflowBudget(workflowId: string, limit: number): RetryBudget {
    return this.setBudget('workflow', workflowId, limit);
  }

  setFamilyBudget(workflowId: string, family: string, limit: number): RetryBudget {
    return this.setBudget('family', `${workflowId}/${family}`, limit);
  }

  setInstanceBudget(
    workflowId: string,
    family: string,
    instanceId: string,
    limit: number,
  ): RetryBudget {
    return this.setBudget('instance', `${workflowId}/${family}/${instanceId}`, limit);
  }

  resolve(task: TaskRef): ResolvedBudget {
    const evidence: RuleEvidence[] = [];
    const candidates: Array<{ scope: BudgetScope; key: string }> = [];

    if (task.instanceId && task.family) {
      candidates.push({
        scope: 'instance',
        key: `${task.workflowId}/${task.family}/${task.instanceId}`,
      });
    }
    if (task.family) {
      candidates.push({ scope: 'family', key: `${task.workflowId}/${task.family}` });
    }
    candidates.push({ scope: 'workflow', key: task.workflowId });

    for (const candidate of candidates) {
      const budget = this.#budgets.get(`${candidate.scope}:${candidate.key}`);
      if (budget) {
        evidence.push({
          rule: 'resolve',
          outcome: `matched ${candidate.scope} budget "${candidate.key}"`,
        });
        return { budget, evidence };
      }
      evidence.push({
        rule: 'resolve',
        outcome: `no ${candidate.scope} budget for "${candidate.key}", falling through`,
      });
    }

    throw new Error(`no retry budget registered at any level for workflow "${task.workflowId}"`);
  }
}
