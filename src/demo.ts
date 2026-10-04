import { buildDeliveryPlan, type EventSpec } from "./engine.js";

const events: EventSpec[] = [
  { id: "ingest", priority: 1, meta: { team: "data" } },
  { id: "validate", priority: 4, deps: ["ingest"] },
  { id: "enrich", priority: 4, deps: ["ingest"] },
  { id: "publish", priority: 9, deps: ["validate", "enrich"], meta: { channel: "cdn" } },
  { id: "audit", priority: 9 },
  { id: "billing", priority: 2, meta: { owner: "finance" } },
  { id: "invoice", priority: 8, deps: ["billing"] },
];

const plan = buildDeliveryPlan(events, ["billing"]);
console.log(JSON.stringify(plan, null, 2));
