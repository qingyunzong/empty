# Referencing an ingredient that was never declared -> diagnostic.
ingredient A {
  cost: 1 CNY / 1 kg;
  stock: 100 g;
}
target: 100 g;
constraint grams(Ghost) <= 10 g;
minimize cost;
