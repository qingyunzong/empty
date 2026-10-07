// Command recipe solves a demo two-scenario integer recipe instance and
// prints the optimal recipe with exact ratios for both public potency
// scenarios, plus the legal processing-order certificate.
package main

import (
	"fmt"
	"math/big"

	"recipe"
)

func r(s string) *big.Rat {
	v, ok := new(big.Rat).SetString(s)
	if !ok {
		panic(s)
	}
	return v
}

func main() {
	p := &recipe.Problem{
		NutrientNames: []string{"protein", "fibre"},
		MaxTypes:      8,
		MaxUnits:      30,
		WeightLo:      r("20"),
		WeightHi:      r("40"),
		NutLo:         []*big.Rat{r("30"), r("12")},
		NutHi:         []*big.Rat{r("90"), r("60")},
		Ingredients: []recipe.Ingredient{
			{Name: "corn", Cost: r("5/2"), Weight: r("1"),
				Pot: [2][]*big.Rat{{r("3"), r("1")}, {r("5/2"), r("3/2")}}},
			{Name: "soy", Cost: r("4"), Weight: r("1"),
				Pot: [2][]*big.Rat{{r("6"), r("1/2")}, {r("11/2"), r("2/3")}}},
			{Name: "bran", Cost: r("3/2"), Weight: r("1"),
				Pot: [2][]*big.Rat{{r("1"), r("3")}, {r("4/3"), r("5/2")}}},
			{Name: "fishmeal", Cost: r("7"), Weight: r("1"),
				Pot: [2][]*big.Rat{{r("9"), r("0")}, {r("8"), r("1/4")}}},
			{Name: "limestone", Cost: r("1/2"), Weight: r("1"),
				Pot: [2][]*big.Rat{{r("0"), r("1/3")}, {r("0"), r("1/3")}}},
			{Name: "molasses", Cost: r("2"), Weight: r("1"),
				Pot: [2][]*big.Rat{{r("2"), r("1")}, {r("3/2"), r("1")}}},
		},
		Mutex: [][2]int{{1, 3}}, // soy and fishmeal may not be mixed
		Prec:  [][2]int{{4, 0}, {4, 5}}, // limestone processed before corn/molasses
	}

	res := recipe.Solve(p)
	fmt.Printf("nodes=%d optimal=%v exhausted=%v\n", res.Nodes, res.Optimal, res.Exhausted)
	if res.Best == nil {
		fmt.Println("no feasible recipe found")
		if res.Exhausted {
			fmt.Printf("certified cost lower bound: %s\n", res.Lower.RatString())
		}
		return
	}
	b := res.Best
	fmt.Printf("min cost: %s   types: %d   weight: %s\n", b.Cost.RatString(), b.Types, b.Weight.RatString())
	fmt.Println("quantities:")
	for i, q := range b.Qty {
		if q > 0 {
			fmt.Printf("  %-9s x%d\n", p.Ingredients[i].Name, q)
		}
	}
	for s := 0; s < 2; s++ {
		fmt.Printf("scenario %d nutrient totals: ", s)
		for j, name := range p.NutrientNames {
			fmt.Printf("%s=%s ", name, b.Nutrients[s][j].RatString())
		}
		fmt.Println()
	}
	fmt.Print("processing order certificate: ")
	for _, idx := range b.Order {
		fmt.Printf("%s ", p.Ingredients[idx].Name)
	}
	fmt.Println()
	fmt.Printf("certificate valid: %v\n", recipe.VerifyOrder(b.Qty, p.Prec, b.Order))
	fmt.Printf("cost bounds: [%s, %s]\n", res.Lower.RatString(), res.Upper.RatString())
}
