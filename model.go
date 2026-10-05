package recipe

import "fmt"

// NumScenarios is the number of public potency scenarios every recipe
// must satisfy simultaneously.
const NumScenarios = 2

// Ingredient describes one raw material. Cost and Weight are per unit.
// Nut[s][k] is the amount of nutrient k contributed by one unit in
// scenario s; potency may differ between the two scenarios.
type Ingredient struct {
	Name   string              `json:"name"`
	Cost   Rat                 `json:"cost"`
	Weight Rat                 `json:"weight"`
	Nut    [NumScenarios][]Rat `json:"nut"`
}

// Instance is a full recipe optimization problem.
type Instance struct {
	Ingredients   []Ingredient `json:"ingredients"`
	NutrientNames []string     `json:"nutrient_names"`
	WeightMin     Rat          `json:"weight_min"`
	WeightMax     Rat          `json:"weight_max"`
	NutMin        []Rat        `json:"nut_min"`
	NutMax        []Rat        `json:"nut_max"`
	MaxTypes      int          `json:"max_types"`  // at most this many distinct ingredients
	MaxUnits      int          `json:"max_units"`  // each ingredient 0..MaxUnits integer units
	Mutex         [][2]int     `json:"mutex"`      // pairs that may not both be used
	Precedence    [][2]int     `json:"precedence"` // (i,j): i must be processed before j when both used
}

// NumNutrients returns the number of constrained nutrients.
func (in *Instance) NumNutrients() int { return len(in.NutMin) }

// Validate checks structural sanity of the instance.
func (in *Instance) Validate() error {
	nk := in.NumNutrients()
	if nk == 0 {
		return fmt.Errorf("recipe: no nutrients defined")
	}
	if len(in.NutMax) != nk {
		return fmt.Errorf("recipe: nut_min/nut_max length mismatch")
	}
	if len(in.NutrientNames) != 0 && len(in.NutrientNames) != nk {
		return fmt.Errorf("recipe: nutrient_names length mismatch")
	}
	if in.MaxTypes < 1 {
		return fmt.Errorf("recipe: max_types must be >= 1")
	}
	if in.MaxUnits < 1 {
		return fmt.Errorf("recipe: max_units must be >= 1")
	}
	if in.WeightMin.Cmp(in.WeightMax) > 0 {
		return fmt.Errorf("recipe: weight_min > weight_max")
	}
	for k := 0; k < nk; k++ {
		if in.NutMin[k].Cmp(in.NutMax[k]) > 0 {
			return fmt.Errorf("recipe: nut_min[%d] > nut_max[%d]", k, k)
		}
	}
	for i, ing := range in.Ingredients {
		if ing.Cost.Sign() < 0 || ing.Weight.Sign() < 0 {
			return fmt.Errorf("recipe: ingredient %d has negative cost/weight", i)
		}
		for s := 0; s < NumScenarios; s++ {
			if len(ing.Nut[s]) != nk {
				return fmt.Errorf("recipe: ingredient %d scenario %d nutrient dimension mismatch", i, s)
			}
			for k := 0; k < nk; k++ {
				if ing.Nut[s][k].Sign() < 0 {
					return fmt.Errorf("recipe: ingredient %d has negative nutrient", i)
				}
			}
		}
	}
	n := len(in.Ingredients)
	for _, p := range in.Mutex {
		if p[0] < 0 || p[0] >= n || p[1] < 0 || p[1] >= n {
			return fmt.Errorf("recipe: mutex pair out of range")
		}
	}
	for _, p := range in.Precedence {
		if p[0] < 0 || p[0] >= n || p[1] < 0 || p[1] >= n {
			return fmt.Errorf("recipe: precedence pair out of range")
		}
	}
	return nil
}

// Eval holds the exact totals of a recipe.
type Eval struct {
	Cost   Rat
	Weight Rat
	Nut    [NumScenarios][]Rat
	Types  int
}

// Evaluate computes exact totals for the given unit counts.
func (in *Instance) Evaluate(counts []int) Eval {
	nk := in.NumNutrients()
	ev := Eval{
		Cost:   Zero(),
		Weight: Zero(),
		Nut: [NumScenarios][]Rat{
			make([]Rat, nk),
			make([]Rat, nk),
		},
	}
	for k := 0; k < nk; k++ {
		ev.Nut[0][k] = Zero()
		ev.Nut[1][k] = Zero()
	}
	for i, c := range counts {
		if c == 0 {
			continue
		}
		ev.Types++
		ing := in.Ingredients[i]
		k64 := int64(c)
		ev.Cost = ev.Cost.Add(ing.Cost.MulInt(k64))
		ev.Weight = ev.Weight.Add(ing.Weight.MulInt(k64))
		for s := 0; s < NumScenarios; s++ {
			for k := 0; k < nk; k++ {
				ev.Nut[s][k] = ev.Nut[s][k].Add(ing.Nut[s][k].MulInt(k64))
			}
		}
	}
	return ev
}

// CheckFeasible returns nil iff counts form a legal recipe: unit bounds,
// type limit, weight and nutrient intervals in BOTH scenarios, mutual
// exclusion, and an acyclic induced precedence relation.
func (in *Instance) CheckFeasible(counts []int) error {
	if len(counts) != len(in.Ingredients) {
		return fmt.Errorf("recipe: counts length mismatch")
	}
	types := 0
	for i, c := range counts {
		if c < 0 || c > in.MaxUnits {
			return fmt.Errorf("recipe: ingredient %d count %d out of range [0,%d]", i, c, in.MaxUnits)
		}
		if c > 0 {
			types++
		}
	}
	if types > in.MaxTypes {
		return fmt.Errorf("recipe: %d types exceeds max_types %d", types, in.MaxTypes)
	}
	for _, p := range in.Mutex {
		if counts[p[0]] > 0 && counts[p[1]] > 0 {
			return fmt.Errorf("recipe: mutex violation on ingredients %d and %d", p[0], p[1])
		}
	}
	ev := in.Evaluate(counts)
	if ev.Weight.Cmp(in.WeightMin) < 0 || ev.Weight.Cmp(in.WeightMax) > 0 {
		return fmt.Errorf("recipe: weight %s outside [%s, %s]", ev.Weight, in.WeightMin, in.WeightMax)
	}
	for s := 0; s < NumScenarios; s++ {
		for k := 0; k < in.NumNutrients(); k++ {
			if ev.Nut[s][k].Cmp(in.NutMin[k]) < 0 || ev.Nut[s][k].Cmp(in.NutMax[k]) > 0 {
				return fmt.Errorf("recipe: scenario %d nutrient %d value %s outside [%s, %s]",
					s, k, ev.Nut[s][k], in.NutMin[k], in.NutMax[k])
			}
		}
	}
	if _, ok := in.TopoOrder(counts); !ok {
		return fmt.Errorf("recipe: precedence cycle among used ingredients")
	}
	return nil
}

// betterEval reports whether a is strictly preferable to b under the
// lexicographic objective (cost, then number of types).
func betterEval(a, b Eval) bool {
	if c := a.Cost.Cmp(b.Cost); c != 0 {
		return c < 0
	}
	return a.Types < b.Types
}
