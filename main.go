// Command cutcli plans how to cut integer-length stock bars into demanded
// pieces. Objective (lexicographic): purchase cost, then scrap, then cut
// cost. Remnants persist across orders via an inventory file with stable IDs.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"cutcli/cutting"
)

func loadJSON(path string, v any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func saveJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(data, '\n'), 0o644)
}

func run(args []string, out io.Writer) int {
	fs := flag.NewFlagSet("cutcli", flag.ContinueOnError)
	fs.SetOutput(out)
	specPath := fs.String("spec", "", "order spec JSON (required)")
	invPath := fs.String("inv", "", "inventory JSON: reuse remnants across orders (created/updated)")
	prevPath := fs.String("prev", "", "previous plan JSON: demand-correction mode, plan only the minimal addition")
	verify := fs.Bool("verify", false, "cross-check the solver against exhaustive enumeration (small instances)")
	outPath := fs.String("out", "", "write the resulting plan JSON to this file")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *specPath == "" {
		fmt.Fprintln(out, "usage: cutcli -spec spec.json [-inv inv.json] [-prev plan.json] [-verify] [-out plan.json]")
		return 2
	}

	var spec cutting.Spec
	if err := loadJSON(*specPath, &spec); err != nil {
		fmt.Fprintf(out, "error: load spec: %v\n", err)
		return 1
	}

	var inv cutting.Inventory
	useInv := *invPath != ""
	if useInv {
		if _, err := os.Stat(*invPath); err == nil {
			if err := loadJSON(*invPath, &inv); err != nil {
				fmt.Fprintf(out, "error: load inventory: %v\n", err)
				return 1
			}
		} else {
			inv.NextRemnantNum = 1
			inv.NextOrderNum = 1
		}
		spec.Remnants = inv.Remnants
		spec.NextRemnantNum = inv.NextRemnantNum
		if spec.OrderID == "" {
			spec.OrderID = fmt.Sprintf("o%d", inv.NextOrderNum)
		}
	}

	if *prevPath != "" {
		var prev cutting.Plan
		if err := loadJSON(*prevPath, &prev); err != nil {
			fmt.Fprintf(out, "error: load previous plan: %v\n", err)
			return 1
		}
		var cut []cutting.PlacedPiece
		for _, b := range prev.Bars {
			cut = append(cut, b.Pieces...)
		}
		remaining, surplus := cutting.RemainingDemand(spec.Demands, cut)
		if len(surplus) > 0 {
			fmt.Fprintf(out, "surplus already cut (cannot be rolled back): %+v\n", surplus)
		}
		if len(remaining) == 0 {
			fmt.Fprintln(out, "demand already satisfied by previous cuts; no additional purchase needed")
			return 0
		}
		fmt.Fprintf(out, "demand correction: remaining demand %+v\n", remaining)
		spec.Demands = remaining
	}

	plan, err := cutting.Solve(&spec)
	if err != nil {
		fmt.Fprintf(out, "error: %v\n", err)
		return 1
	}
	fmt.Fprint(out, plan.Report())

	if *verify {
		key, ok, err := cutting.Exhaustive(&spec)
		if err != nil {
			fmt.Fprintf(out, "verify: %v\n", err)
			return 1
		}
		got := cutting.Objective(plan)
		want := key.Tuple()
		if !ok || got != want {
			fmt.Fprintf(out, "verify: MISMATCH solver=%v exhaustive=%v\n", got, want)
			return 1
		}
		fmt.Fprintf(out, "verify: exhaustive enumeration confirms optimum (purchase=%d scrap=%d cutCost=%d)\n",
			want[0], want[1], want[2])
	}

	if *outPath != "" {
		if err := saveJSON(*outPath, plan); err != nil {
			fmt.Fprintf(out, "error: write plan: %v\n", err)
			return 1
		}
	}
	if useInv {
		inv.ApplyPlan(plan, spec.NextRemnantNum)
		if err := saveJSON(*invPath, &inv); err != nil {
			fmt.Fprintf(out, "error: write inventory: %v\n", err)
			return 1
		}
		fmt.Fprintf(out, "inventory updated: %d remnants in stock\n", len(inv.Remnants))
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout))
}
