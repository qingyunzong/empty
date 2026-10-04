# Two semi-finished batches share one raw material.
let upstream = ancestors(LOT-2025-0004);
query upstream where type == "semi" and date >= 2025-01-03 or type == "raw";
query descendants(LOT-2025-0001);
query shortestPath(LOT-2025-0001, LOT-2025-0004);
