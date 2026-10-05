// Command routecli plans the cheapest-then-fastest simple route through a
// toll network with cumulative-toll rebates (redeemed only at designated
// stations), mutually exclusive edge-set coupons, and fuel capacity with
// priced refueling.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"

	"routecli/route"
)

func main() {
	input := flag.String("input", "", "network JSON file (default: stdin)")
	budget := flag.Int("budget", 0, "branch-and-bound expansion budget (0 = unlimited)")
	verify := flag.Bool("verify", false, "cross-check against simple-path enumeration and finite-state search")
	flag.Parse()

	var r io.Reader = os.Stdin
	if *input != "" {
		f, err := os.Open(*input)
		if err != nil {
			fatal("open input: %v", err)
		}
		defer f.Close()
		r = f
	}
	net, err := route.Load(r)
	if err != nil {
		fatal("load: %v", err)
	}

	res := net.BranchBound(*budget)
	fmt.Printf("search: expansions=%d budget=%d", res.Expansions, res.Budget)
	if res.BudgetExceeded {
		fmt.Print(" status=BUDGET_EXCEEDED (best feasible + lower bound retained)")
	} else {
		fmt.Print(" status=OPTIMAL")
	}
	fmt.Println()
	fmt.Printf("lower-bound-on-paid: %d\n", res.LowerBound)
	if !res.Found {
		fmt.Println("no feasible route")
	} else {
		fmt.Print("best route (paid-first, time-second):\n")
		fmt.Print(res.Best.Ledger())
	}

	if *verify {
		fmt.Println("--- cross-checks ---")
		if enum, ok := net.Enumerate(); ok {
			fmt.Printf("simple-path enumeration: paid=%d time=%d path=%v\n", enum.Paid, enum.Time, enum.Path)
			if res.Found && (enum.Paid != res.Best.Paid || enum.Time != res.Best.Time) {
				fmt.Println("MISMATCH: branch-and-bound != enumeration")
				os.Exit(1)
			}
		} else {
			fmt.Println("simple-path enumeration: no feasible route")
		}
		if ss, ok := net.StateSearch(); ok {
			fmt.Printf("finite-state search:     paid=%d time=%d path=%v\n", ss.Paid, ss.Time, ss.Path)
			if res.Found && (ss.Paid != res.Best.Paid || ss.Time != res.Best.Time) {
				fmt.Println("MISMATCH: branch-and-bound != finite-state search")
				os.Exit(1)
			}
		} else {
			fmt.Println("finite-state search: no feasible route")
		}
		if res.Optimal {
			fmt.Println("cross-check: OK (budget sufficient, results agree)")
		} else {
			fmt.Println("cross-check: budget exceeded; enumeration/state-search give the true optimum for comparison")
		}
	}
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "routecli: "+format+"\n", args...)
	os.Exit(2)
}
