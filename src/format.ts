import { Plan } from "./types";

// 输出每一步启用后已具备的能力集合。
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  lines.push(`step 0 (initial): held = { ${plan.initial.join(", ")} }`);
  plan.steps.forEach((step, i) => {
    const prev = plan.steps[i - 1];
    const before = prev ? prev.heldAfter : plan.initial;
    const gained = step.plugin.provides.filter((cap) => !before.includes(cap));
    lines.push(
      `step ${i + 1}: enable ${step.plugin.id} (cost ${step.plugin.cost})` +
        ` | +{ ${gained.join(", ")} }` +
        ` | held = { ${step.heldAfter.join(", ")} }`,
    );
  });
  lines.push(`total cost: ${plan.totalCost}`);
  return lines.join("\n");
}
