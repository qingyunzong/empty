import {
  MAX_GROUPS,
  REVENUE_TABLE_SIZE,
  type ChannelSpec,
  type GroupSpec,
  type Problem,
} from "./types.js";

function fail(message: string): never {
  throw new Error(`invalid input: ${message}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asInt(value: unknown, path: string, min = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${path} must be an integer`);
  }
  if (value < min) fail(`${path} must be >= ${min}`);
  return value;
}

function asId(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${path} must be a non-empty string`);
  }
  return value;
}

export function validateProblem(raw: unknown): Problem {
  const root = asRecord(raw, "root");

  if (!Array.isArray(root.channels)) fail("channels must be an array");
  const channels: ChannelSpec[] = root.channels.map((c, i) => {
    const rec = asRecord(c, `channels[${i}]`);
    return { id: asId(rec.id, `channels[${i}].id`), budget: asInt(rec.budget, `channels[${i}].budget`) };
  });
  const channelIds = new Set(channels.map((c) => c.id));
  if (channelIds.size !== channels.length) fail("channel ids must be unique");

  const minImpressions = asInt(root.minImpressions, "minImpressions");

  if (!Array.isArray(root.groups)) fail("groups must be an array");
  if (root.groups.length > MAX_GROUPS) fail(`groups must contain at most ${MAX_GROUPS} entries`);
  const groups: GroupSpec[] = root.groups.map((g, i) => {
    const rec = asRecord(g, `groups[${i}]`);
    const channel = asId(rec.channel, `groups[${i}].channel`);
    if (!channelIds.has(channel)) fail(`groups[${i}].channel references unknown channel "${channel}"`);
    if (!Array.isArray(rec.revenue) || rec.revenue.length !== REVENUE_TABLE_SIZE) {
      fail(`groups[${i}].revenue must be an array of ${REVENUE_TABLE_SIZE} integers (amounts 0..10)`);
    }
    const revenue = rec.revenue.map((v, x) => asInt(v, `groups[${i}].revenue[${x}]`));
    return {
      id: asId(rec.id, `groups[${i}].id`),
      channel,
      unitCost: asInt(rec.unitCost, `groups[${i}].unitCost`),
      unitImpressions: asInt(rec.unitImpressions, `groups[${i}].unitImpressions`),
      revenue,
    };
  });
  const groupIds = new Set(groups.map((g) => g.id));
  if (groupIds.size !== groups.length) fail("group ids must be unique");

  return { channels, minImpressions, groups };
}
