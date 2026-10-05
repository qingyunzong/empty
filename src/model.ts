// 数据模型与输入校验。全部数值均为整数。

export const MAX_GROUPS = 16;
export const MAX_QUANTITY = 10;

export interface Channel {
  id: string;
  budget: number; // 整数预算（该渠道总花费上限）
}

export interface AdGroup {
  id: string;
  channel: string; // 引用 Channel.id
  unitCost: number; // 每单位投放的整数成本
  unitExposure: number; // 每单位投放的整数曝光
  revenue: number[]; // 长度 11 的非线性整数收益表，revenue[q] 为投放 q 单位的收益
}

export interface PlanInput {
  channels: Channel[];
  exposureLowerBound: number; // 总曝光整数下限
  groups: AdGroup[];
}

export interface Allocation {
  groupId: string;
  channel: string;
  quantity: number;
  cost: number;
  exposure: number;
  revenue: number;
}

export interface Solution {
  status: 'optimal' | 'infeasible';
  quantities: number[]; // 每个广告组的投放量（infeasible 时为空）
  allocations: Allocation[];
  totalRevenue: number;
  totalCost: number;
  totalExposure: number;
  channelSpend: Record<string, number>;
  statesExplored: number; // 求解过程中考察的 DP 状态数（最优性证据之一）
  frontierHash: string; // 最终 DP 前沿（状态->最优收益/成本）的 SHA-256，供证书核对
}

function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export function validateInput(raw: unknown): PlanInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('输入必须是 JSON 对象');
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.channels) || obj.channels.length === 0) {
    throw new Error('channels 必须是非空数组');
  }
  const channels: Channel[] = obj.channels.map((c: unknown, i: number) => {
    const ch = c as Record<string, unknown>;
    if (typeof ch.id !== 'string' || ch.id.length === 0) throw new Error(`channels[${i}].id 缺失`);
    if (!isInt(ch.budget) || ch.budget < 0) throw new Error(`channels[${i}].budget 必须是非负整数`);
    return { id: ch.id, budget: ch.budget };
  });
  const channelIds = new Set(channels.map((c) => c.id));
  if (channelIds.size !== channels.length) throw new Error('channels 存在重复 id');

  if (!isInt(obj.exposureLowerBound) || obj.exposureLowerBound < 0) {
    throw new Error('exposureLowerBound 必须是非负整数');
  }

  if (!Array.isArray(obj.groups) || obj.groups.length === 0) {
    throw new Error('groups 必须是非空数组');
  }
  if (obj.groups.length > MAX_GROUPS) {
    throw new Error(`广告组数量至多为 ${MAX_GROUPS}，实际为 ${obj.groups.length}`);
  }
  const groups: AdGroup[] = obj.groups.map((g: unknown, i: number) => {
    const gr = g as Record<string, unknown>;
    if (typeof gr.id !== 'string' || gr.id.length === 0) throw new Error(`groups[${i}].id 缺失`);
    if (typeof gr.channel !== 'string' || !channelIds.has(gr.channel)) {
      throw new Error(`groups[${i}].channel 未在 channels 中定义`);
    }
    if (!isInt(gr.unitCost) || gr.unitCost < 0) throw new Error(`groups[${i}].unitCost 必须是非负整数`);
    if (!isInt(gr.unitExposure) || gr.unitExposure < 0) throw new Error(`groups[${i}].unitExposure 必须是非负整数`);
    if (!Array.isArray(gr.revenue) || gr.revenue.length !== MAX_QUANTITY + 1) {
      throw new Error(`groups[${i}].revenue 必须是长度 ${MAX_QUANTITY + 1} 的数组（量 0 至 ${MAX_QUANTITY}）`);
    }
    const revenue = gr.revenue.map((v: unknown, q: number) => {
      if (!isInt(v) || v < 0) throw new Error(`groups[${i}].revenue[${q}] 必须是非负整数`);
      return v;
    });
    if (revenue[0] !== 0) throw new Error(`groups[${i}].revenue[0] 必须为 0`);
    return { id: gr.id, channel: gr.channel, unitCost: gr.unitCost, unitExposure: gr.unitExposure, revenue };
  });
  const groupIds = new Set(groups.map((g) => g.id));
  if (groupIds.size !== groups.length) throw new Error('groups 存在重复 id');

  return { channels, exposureLowerBound: obj.exposureLowerBound, groups };
}
