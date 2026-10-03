# Stock cannot cover the target mass -> INFEASIBLE.
ingredient A {
  cost: 1 CNY / 1 kg;
  stock: 30 g;
}
ingredient B {
  cost: 1 CNY / 1 kg;
  stock: 40 g;
}
target: 100 g;
step: 10 g;
minimize cost;
