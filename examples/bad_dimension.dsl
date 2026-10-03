# Mixing kg and ppm in one addition -> static type error (exit 2).
ingredient A {
  cost: 1 CNY / 1 kg;
  stock: 1 kg + 5 ppm;
}
target: 100 g;
minimize cost;
