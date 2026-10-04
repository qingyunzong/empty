export const MAX_GROUPS = 16;
export const MAX_AMOUNT = 10;
export const REVENUE_TABLE_SIZE = MAX_AMOUNT + 1;

export interface ChannelSpec {
  id: string;
  budget: number;
}

export interface GroupSpec {
  id: string;
  channel: string;
  unitCost: number;
  unitImpressions: number;
  /** revenue[x] 为投放量 x（0..10）对应的收益，整数，允许非线性。 */
  revenue: number[];
}

export interface Problem {
  channels: ChannelSpec[];
  minImpressions: number;
  groups: GroupSpec[];
}

export interface Solution {
  feasible: boolean;
  revenue: number;
  cost: number;
  impressions: number;
  /** 每个广告组选中的投放量（0..10），不可行时为 null。 */
  amounts: number[] | null;
  stats: { statesExplored: number };
}
