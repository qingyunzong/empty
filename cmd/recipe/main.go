// Command recipe solves a recipe optimization instance given as JSON and
// prints an exact rational report: optimal (or best-bounded) recipe,
// dual-scenario nutrient ratios, processing-order certificate, and cost
// bounds. With -verify it independently re-enumerates the instance and
// cross-checks the solver's answer (small instances only).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"recipe"
)

type report struct {
	Optimal   bool              `json:"optimal"`
	Found     bool              `json:"found"`
	Counts    map[string]int    `json:"counts,omitempty"`
	Types     int               `json:"types,omitempty"`
	Cost      string            `json:"cost,omitempty"`
	Weight    string            `json:"weight,omitempty"`
	Scenario1 map[string]string `json:"scenario_1_nutrients,omitempty"`
	Scenario2 map[string]string `json:"scenario_2_nutrients,omitempty"`
	Order     []string          `json:"processing_order,omitempty"`
	OrderOK   *bool             `json:"processing_order_valid,omitempty"`
	Lower     string            `json:"cost_lower_bound"`
	Upper     string            `json:"cost_upper_bound,omitempty"`
	Nodes     int64             `json:"nodes"`
	Verified  *bool             `json:"independent_enumeration_match,omitempty"`
}

func main() {
	inFile := flag.String("in", "", "instance JSON file (default: stdin)")
	budget := flag.Int64("budget", -1, "search node budget (negative: unlimited)")
	verify := flag.Bool("verify", false, "cross-check with independent brute-force enumeration")
	flag.Parse()

	var data []byte
	var err error
	if *inFile == "" {
		data, err = io.ReadAll(os.Stdin)
	} else {
		data, err = os.ReadFile(*inFile)
	}
	if err != nil {
		fatal(err)
	}
	var inst recipe.Instance
	if err := json.Unmarshal(data, &inst); err != nil {
		fatal(err)
	}
	if err := inst.Validate(); err != nil {
		fatal(err)
	}

	res := recipe.Solve(&inst, *budget)
	rep := report{
		Optimal: res.Optimal,
		Found:   res.Found,
		Lower:   res.Lower.String(),
		Nodes:   res.Nodes,
	}
	if res.Found {
		rep.Upper = res.Upper.String()
		rep.Cost = res.Eval.Cost.String()
		rep.Weight = res.Eval.Weight.String()
		rep.Types = res.Eval.Types
		rep.Counts = map[string]int{}
		for i, c := range res.Counts {
			if c > 0 {
				rep.Counts[inst.Ingredients[i].Name] = c
			}
		}
		nutrientName := func(k int) string {
			if k < len(inst.NutrientNames) {
				return inst.NutrientNames[k]
			}
			return fmt.Sprintf("nutrient_%d", k)
		}
		rep.Scenario1 = map[string]string{}
		rep.Scenario2 = map[string]string{}
		for k := 0; k < inst.NumNutrients(); k++ {
			rep.Scenario1[nutrientName(k)] = res.Eval.Nut[0][k].String()
			rep.Scenario2[nutrientName(k)] = res.Eval.Nut[1][k].String()
		}
		for _, idx := range res.Order {
			rep.Order = append(rep.Order, inst.Ingredients[idx].Name)
		}
		ok := inst.VerifyOrder(res.Counts, res.Order)
		rep.OrderOK = &ok
	}
	if *verify {
		best, ev, found := recipe.BruteForce(&inst)
		ok := found == res.Found
		if ok && found {
			ok = ev.Cost.Cmp(res.Eval.Cost) == 0 && ev.Types == res.Eval.Types
			_ = best
		}
		rep.Verified = &ok
	}
	out, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		fatal(err)
	}
	fmt.Println(string(out))
	if rep.OrderOK != nil && !*rep.OrderOK {
		os.Exit(1)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "recipe:", err)
	os.Exit(2)
}
