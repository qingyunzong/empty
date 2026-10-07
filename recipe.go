package recipe

import (
	"errors"
	"fmt"
	"math/big"
)

// NumScenarios is the number of public potency scenarios every
// feasible recipe must satisfy simultaneously.
const NumScenarios = 2

// Ingredient describes one raw material.
//
// Cost and Weight are per-unit exact rationals. Pot[s][k] is the
// per-unit potency of nutrient k in scenario s; potencies may differ
// between the two public scenarios (batch variability).
type Ingredient struct {
	Name   string
	Cost   *big.Rat
	Weight *big.Rat
	Pot    [NumScenarios][]*big.Rat
}

// Problem is a full recipe optimisation instance.
type Problem struct {
	Ingredients   []Ingredient
	NutrientNames []string

	MaxTypes int // max distinct ingredients with qty > 0 (spec: 8)
	MaxUnits int // max units per ingredient, 0..MaxUnits (spec: 30)

	WeightLo *big.Rat   // total weight must lie in [WeightLo, WeightHi]
	WeightHi *big.Rat
	NutLo    []*big.Rat // per-nutrient total must lie in [NutLo[k], NutHi[k]]
	NutHi    []*big.Rat // ... in BOTH scenarios

	Mutex [][2]int // ingredient index pairs that may not both be used
	Prec  [][2]int // (before, after): if both used, before must be
	// processed earlier than after in the processing order

	Budget int64 // max branch-and-bound nodes; <= 0 means unlimited
}

// Solution is one feasible integer recipe together with its exact
// dual-scenario ratios and a legal processing-order certificate.
type Solution struct {
	Qty       []int
	Types     int
	Cost      *big.Rat
	Weight    *big.Rat
	Nutrients [NumScenarios][]*big.Rat // totals per scenario
	Order     []int                    // topological processing certificate
}

// Result is the outcome of a Solve run.
type Result struct {
	Best      *Solution // nil when no feasible recipe was found
	Lower     *big.Rat  // certified lower bound on the optimal cost
	Upper     *big.Rat  // certified upper bound (= Best.Cost when found)
	Optimal   bool      // search completed: Best is proven optimal
	Exhausted bool      // budget ran out before optimality was proven
	Nodes     int64     // branch-and-bound nodes visited
}

// Validate checks structural sanity of the instance.
func (p *Problem) Validate() error {
	n := len(p.Ingredients)
	k := len(p.NutrientNames)
	if len(p.NutLo) != k || len(p.NutHi) != k {
		return errors.New("recipe: nutrient bound vector length mismatch")
	}
	for i := range p.Ingredients {
		ing := &p.Ingredients[i]
		for s := 0; s < NumScenarios; s++ {
			if len(ing.Pot[s]) != k {
				return fmt.Errorf("recipe: ingredient %q potency length mismatch in scenario %d", ing.Name, s)
			}
		}
		if ltRat(ing.Cost, ratInt(0)) || ltRat(ing.Weight, ratInt(0)) {
			return fmt.Errorf("recipe: ingredient %q has negative cost or weight", ing.Name)
		}
	}
	for _, pair := range p.Mutex {
		if pair[0] < 0 || pair[0] >= n || pair[1] < 0 || pair[1] >= n {
			return errors.New("recipe: mutex index out of range")
		}
	}
	for _, edge := range p.Prec {
		if edge[0] < 0 || edge[0] >= n || edge[1] < 0 || edge[1] >= n {
			return errors.New("recipe: precedence index out of range")
		}
	}
	return nil
}

// totals computes exact cost, weight and per-scenario nutrient totals
// for a quantity vector.
func (p *Problem) totals(qty []int) (cost, weight *big.Rat, nut [NumScenarios][]*big.Rat) {
	cost = ratInt(0)
	weight = ratInt(0)
	k := len(p.NutrientNames)
	for s := 0; s < NumScenarios; s++ {
		nut[s] = make([]*big.Rat, k)
		for j := range nut[s] {
			nut[s][j] = ratInt(0)
		}
	}
	for i, q := range qty {
		if q == 0 {
			continue
		}
		qRat := ratInt(int64(q))
		ing := &p.Ingredients[i]
		cost.Add(cost, new(big.Rat).Mul(qRat, ing.Cost))
		weight.Add(weight, new(big.Rat).Mul(qRat, ing.Weight))
		for s := 0; s < NumScenarios; s++ {
			for j := 0; j < k; j++ {
				nut[s][j].Add(nut[s][j], new(big.Rat).Mul(qRat, ing.Pot[s][j]))
			}
		}
	}
	return cost, weight, nut
}

// usedIndices returns the indices of ingredients with qty > 0.
func usedIndices(qty []int) []int {
	var used []int
	for i, q := range qty {
		if q > 0 {
			used = append(used, i)
		}
	}
	return used
}

// Evaluate fully checks a quantity vector against every constraint and,
// when feasible, returns the corresponding Solution with its exact
// dual-scenario ratios and processing-order certificate.
func (p *Problem) Evaluate(qty []int) (*Solution, error) {
	if len(qty) != len(p.Ingredients) {
		return nil, errors.New("recipe: quantity vector length mismatch")
	}
	used := usedIndices(qty)
	if len(used) > p.MaxTypes {
		return nil, fmt.Errorf("recipe: %d ingredient types exceed limit %d", len(used), p.MaxTypes)
	}
	for _, q := range qty {
		if q < 0 || q > p.MaxUnits {
			return nil, fmt.Errorf("recipe: quantity %d outside [0,%d]", q, p.MaxUnits)
		}
	}
	inUse := make([]bool, len(qty))
	for _, i := range used {
		inUse[i] = true
	}
	for _, pair := range p.Mutex {
		if inUse[pair[0]] && inUse[pair[1]] {
			return nil, fmt.Errorf("recipe: mutually exclusive ingredients %d and %d both used", pair[0], pair[1])
		}
	}
	cost, weight, nut := p.totals(qty)
	if ltRat(weight, p.WeightLo) || gtRat(weight, p.WeightHi) {
		return nil, fmt.Errorf("recipe: total weight %s outside [%s, %s]",
			frac(weight), frac(p.WeightLo), frac(p.WeightHi))
	}
	for s := 0; s < NumScenarios; s++ {
		for j := range nut[s] {
			if ltRat(nut[s][j], p.NutLo[j]) || gtRat(nut[s][j], p.NutHi[j]) {
				return nil, fmt.Errorf("recipe: nutrient %s total %s in scenario %d outside [%s, %s]",
					p.NutrientNames[j], frac(nut[s][j]), s, frac(p.NutLo[j]), frac(p.NutHi[j]))
			}
		}
	}
	order, ok := TopoOrder(used, p.Prec)
	if !ok {
		return nil, errors.New("recipe: precedence constraints contain a cycle among used ingredients")
	}
	return &Solution{
		Qty:       append([]int(nil), qty...),
		Types:     len(used),
		Cost:      cost,
		Weight:    weight,
		Nutrients: nut,
		Order:     order,
	}, nil
}

// better reports whether candidate a strictly beats incumbent b under
// the lexicographic objective: minimum cost, then fewer types.
func better(a, b *Solution) bool {
	if b == nil {
		return true
	}
	if c := cmpRat(a.Cost, b.Cost); c != 0 {
		return c < 0
	}
	return a.Types < b.Types
}
