# Feasible, but the cheapest mix costs more than the budget -> OVER_BUDGET.
ingredient A {
  cost: 5 CNY / 1 kg;
  stock: 100 g;
  allergen: 5 ppm;
}
ingredient B {
  cost: 9 CNY / 1 kg;
  stock: 100 g;
  allergen: 50 ppm;
}
target: 100 g;
step: 10 g;
budget: 0.4 CNY;
minimize cost;
