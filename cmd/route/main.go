// Command route solves routing problems with per-edge tolls, a one-time
// cumulative full-amount rebate (redeemed only at designated stations),
// mutually exclusive coupons earned from traveled edges, and fuel
// capacity with refueling costs. Paths are simple and limited to at most
// maxNodes nodes. Ordering: actual paid cost first, then travel time.
//
// Usage:
//
//	route solve [-budget N] problem.json     best route + per-edge cost process
//	route verify [-budget N] problem.json    cross-check search vs enumeration
//	route enumerate problem.json             brute-force simple-path reference
//
// problem.json may be "-" to read from stdin.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"routecli/internal/route"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd := os.Args[1]
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	budget := fs.Int("budget", 0, "max label expansions for solve/verify (0 = unlimited)")
	fs.Parse(os.Args[2:])
	if fs.NArg() != 1 {
		usage()
		os.Exit(2)
	}
	p, err := route.LoadFile(fs.Arg(0))
	if err != nil {
		fatal(err)
	}
	switch cmd {
	case "solve":
		res := p.Search(*budget)
		printSearch(p, res)
	case "enumerate":
		en := p.Enumerate()
		printEnumeration(en)
	case "verify":
		res := p.Search(*budget)
		en := p.Enumerate()
		printSearch(p, res)
		fmt.Println()
		printEnumeration(en)
		fmt.Println()
		if !res.Exhausted {
			if res.Found != en.Found ||
				(res.Found && (res.Cost != en.Best.Cost || res.Time != en.Best.Time)) {
				fmt.Println("VERIFY: MISMATCH between search and enumeration")
				os.Exit(1)
			}
			fmt.Println("VERIFY: OK (search matches simple-path enumeration)")
		} else {
			if en.Found && res.Found &&
				(res.LowerBound > en.Best.Cost || res.Cost < en.Best.Cost) {
				fmt.Println("VERIFY: MISMATCH (bound/feasible inconsistent with enumeration)")
				os.Exit(1)
			}
			fmt.Println("VERIFY: OK (budget exhausted; best feasible and lower bound consistent)")
		}
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `usage:
  route solve [-budget N] problem.json
  route verify [-budget N] problem.json
  route enumerate problem.json
`)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func edgeName(p *route.Problem, eid int) string {
	e := p.Edges[eid]
	return fmt.Sprintf("#%d %d->%d", eid, e.From, e.To)
}

func printSearch(p *route.Problem, res route.SearchResult) {
	fmt.Println("== search ==")
	fmt.Printf("expansions: %d  budgetExhausted: %v\n", res.Expansions, res.Exhausted)
	if !res.Found {
		fmt.Println("no feasible route")
		if res.Exhausted {
			fmt.Printf("lower bound: %d\n", res.LowerBound)
		}
		return
	}
	fmt.Printf("cost: %d  time: %d  lowerBound: %d\n", res.Cost, res.Time, res.LowerBound)
	printSimulation(p, res.Sim)
}

func printEnumeration(en route.Enumeration) {
	fmt.Println("== enumeration (simple paths) ==")
	fmt.Printf("simple paths examined: %d  feasible: %d\n", en.Visited, en.Paths)
	if !en.Found {
		fmt.Println("no feasible route")
		return
	}
	fmt.Printf("cost: %d  time: %d\n", en.Best.Cost, en.Best.Time)
}

func printSimulation(p *route.Problem, sim route.Simulation) {
	if !sim.OK {
		fmt.Println("simulation infeasible:", sim.Reason)
		return
	}
	var b strings.Builder
	fmt.Fprintf(&b, "path nodes: %d", p.Start)
	for _, eid := range sim.Path {
		fmt.Fprintf(&b, " -> %d", p.Edges[eid].To)
	}
	fmt.Println(b.String())
	fmt.Printf("tolls: %d  fuel: %d  rebate: -%d  coupon: %d\n",
		sim.TollCost, sim.FuelCost, sim.RebateRedeemed, sim.CouponUsed)
	fmt.Println("per-edge status:")
	fmt.Println("edge        toll  cpn  disc  netToll  cumToll  rebate  refuel  fuelCost  fuelB->A  cumCost  cumTime")
	for _, st := range sim.Steps {
		fmt.Printf("%-11s %4d  %3d  %4d  %7d  %8d  %6d  %7d  %9d  %4d->%-4d %8d  %8d\n",
			edgeName(p, st.Edge), st.Toll, st.Coupon, st.CouponDiscount,
			st.NetToll, st.CumNetToll, st.RebateRedeemed, st.RefuelBought,
			st.RefuelCost, st.FuelBefore, st.FuelAfter, st.CumCost, st.CumTime)
	}
}
