# Which raw materials went into the finished bread?
let base = ancestors(LOT-2025-0005);
base where type == "raw_material" and date >= 2025-01-01 order by id asc;

# How does the flour lot reach the product?
shortestPath(LOT-2025-0001, LOT-2025-0005);
