// Command flp reads a facility location instance as JSON (from a file argument
// or stdin) and prints the exact optimal solution as JSON, including the
// capacity certificate and, when "budget" is present, the budget verdict.
//
// Input format:
//
//	{
//	  "sites":   [{"id":"S1","open_cost":10,"capacity":7,"x":0,"y":0}, ...],
//	  "demands": [{"id":"D1","amount":4,"x":1,"y":0}, ...],
//	  "max_dist": 5.0,
//	  "budget": 100.0        // optional
//	}
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"flp"
)

func main() {
	var r io.Reader = os.Stdin
	if len(os.Args) > 2 {
		fmt.Fprintln(os.Stderr, "usage: flp [instance.json] < instance.json")
		os.Exit(2)
	}
	if len(os.Args) == 2 {
		f, err := os.Open(os.Args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, "flp:", err)
			os.Exit(2)
		}
		defer f.Close()
		r = f
	}
	var cfg struct {
		Sites   []flp.Site   `json:"sites"`
		Demands []flp.Demand `json:"demands"`
		MaxDist float64      `json:"max_dist"`
		Budget  *float64     `json:"budget"`
	}
	if err := json.NewDecoder(r).Decode(&cfg); err != nil {
		fmt.Fprintln(os.Stderr, "flp: invalid JSON input:", err)
		os.Exit(2)
	}
	budget := -1.0
	if cfg.Budget != nil {
		budget = *cfg.Budget
	}
	inst := flp.Instance{Sites: cfg.Sites, Demands: cfg.Demands, MaxDist: cfg.MaxDist}
	res, err := flp.Solve(inst, budget)
	if err != nil {
		fmt.Fprintln(os.Stderr, "flp:", err)
		os.Exit(1)
	}
	out, err := json.MarshalIndent(res, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, "flp:", err)
		os.Exit(1)
	}
	fmt.Println(string(out))
	if res.Feasible {
		if err := res.Verify(inst); err != nil {
			fmt.Fprintln(os.Stderr, "flp: internal certificate error:", err)
			os.Exit(1)
		}
	} else {
		os.Exit(3)
	}
}
