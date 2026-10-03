// 示例：两种原料的配合饲料，蛋白含量约束 + 成本预算。
recipe "feed-mix";

macro min_protein = 200000 ppm;   // 成品蛋白质量分数下限
macro max_fat = 60000 ppm;

ingredient corn {
  cost 3.2 CNY/kg;
  stock 10 kg;
  allergen 1;
  protein 90000 ppm;
  fat 40000 ppm;
}

ingredient soy {
  cost 4.8 CNY/kg;
  stock 5 kg;
  allergen 3;
  protein 400000 ppm;
  fat 20000 ppm;
}

total 1 kg;
step 100 g;
budget 5 CNY;

constraint corn.protein * corn.grams + soy.protein * soy.grams >= min_protein * (corn.grams + soy.grams);
constraint corn.fat * corn.grams + soy.fat * soy.grams <= max_fat * (corn.grams + soy.grams);

minimize corn.grams * corn.cost + soy.grams * soy.cost;
