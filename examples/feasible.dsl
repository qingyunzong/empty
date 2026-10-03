# Feasible sample: pick an integer-gram mix within stock, quality and budget.
macro protein_floor = 80000 ppm;   # shared quality floor

ingredient Flour {
  cost: 4 CNY / 1 kg;        # 4000 micro-CNY per gram
  stock: 500 g;
  allergen: 30 ppm;
  indicator protein: 120000 ppm;
  indicator fat: 15000 ppm;
}

ingredient SoyMeal {
  cost: 6 CNY / 1 kg;
  stock: 0.3 kg;
  allergen: 120 ppm;
  indicator protein: 450000 ppm;
  indicator fat: 20000 ppm;
}

ingredient Bran {
  cost: 2 CNY / 1 kg;
  stock: 200 g;
  allergen: 10 ppm;
  indicator protein: 60000 ppm;
  indicator fat: 40000 ppm;
}

target: 200 g;
step: 20 g;
budget: 2 CNY;

constraint protein in [protein_floor, 400000 ppm];
constraint fat <= 30000 ppm;
constraint cost <= budget_ref;

macro budget_ref = 1.5 CNY;

minimize cost;
