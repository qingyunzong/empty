# Lexically scoped macros may not expand recursively.
macro alpha = beta + 1 g;
macro beta = alpha + 1 g;
ingredient A {
  cost: 1 CNY / 1 kg;
  stock: alpha;
}
target: 100 g;
minimize cost;
