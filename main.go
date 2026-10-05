package main

import (
	"flag"
	"fmt"
	"math"
	"os"
	"time"
)

func main() {
	var (
		scenarioPath = flag.String("scenario", "", "path to scenario JSON file")
		resumePath   = flag.String("resume", "", "resume from a saved frontier snapshot")
		savePath     = flag.String("save", "frontier.json", "snapshot output path when the search pauses")
		maxPops      = flag.Int("max-pops", 0, "pause after this many state expansions (0 = no limit)")
		deadlineSec  = flag.Float64("deadline", 60, "wall-clock budget in seconds (capped at 60)")
		verify       = flag.Bool("verify", false, "cross-check with the independent exhaustive search")
		demo         = flag.Bool("demo", false, "solve the built-in demo scenario")
	)
	flag.Parse()

	var sc *Scenario
	var err error
	switch {
	case *demo:
		sc = demoScenario()
	case *scenarioPath != "":
		sc, err = LoadScenario(*scenarioPath)
		if err != nil {
			fatal(err)
		}
	default:
		fatal(fmt.Errorf("provide -scenario <file> or -demo"))
	}
	if err := sc.Validate(); err != nil {
		fatal(err)
	}

	if *deadlineSec > MaxHorizon {
		*deadlineSec = MaxHorizon
	}
	deadline := time.Now().Add(time.Duration(*deadlineSec * float64(time.Second)))

	var sv *Solver
	if *resumePath != "" {
		sv, err = ResumeSolver(sc, *resumePath)
		if err != nil {
			fatal(err)
		}
		fmt.Printf("resumed: %d queued frontier states, %d expansions so far\n", len(sv.pq), sv.Pops)
	} else {
		sv = NewSolver(sc)
	}

	paused := sv.Run(*maxPops, deadline)
	if paused {
		if err := sv.SaveSnapshot(*savePath); err != nil {
			fatal(err)
		}
		fmt.Printf("paused after %d expansions; frontier of %d states saved to %s\n", sv.Pops, len(sv.pq), *savePath)
		fmt.Printf("current optimal-cost lower bound: %s\n", boundStr(sv.FrontierLowerBound()))
		fmt.Println("resume with: -scenario <file> -resume " + *savePath)
		return
	}

	if !sv.Found {
		fmt.Println("goal unreachable within the time horizon")
		if *verify {
			if _, found := BruteForce(sc); found {
				fatal(fmt.Errorf("cross-check FAILED: brute force found a route"))
			}
			fmt.Println("verify: exhaustive search agrees (unreachable)")
		}
		return
	}

	fmt.Printf("optimal cost: %d (%d expansions)\n", sv.Best, sv.Pops)
	fmt.Printf("lower bound at start (relaxed graph): %s\n", boundStr(sv.h[sc.Start]))
	cert := sv.Certificate()
	fmt.Printf("certificate (%d transitions):\n", len(cert))
	printCertificate(sc, cert)

	if *verify {
		best, found := BruteForce(sc)
		if !found || best != sv.Best {
			fatal(fmt.Errorf("cross-check FAILED: astar=%d brute=%v/%d", sv.Best, found, best))
		}
		fmt.Printf("verify: exhaustive search agrees (optimum %d)\n", best)
	}
}

func boundStr(b int) string {
	if b >= math.MaxInt32/2 {
		return "inf"
	}
	return fmt.Sprintf("%d", b)
}

func printCertificate(sc *Scenario, cert []Action) {
	g := 0
	fmt.Printf("  start  %s\n", formatState(State{Node: sc.Start, Fuel: sc.StartFuel}))
	for i, a := range cert {
		g += a.Cost
		fmt.Printf("  %2d. %-58s +%-3d total=%-4d %s\n", i+1, describeAction(sc, a), a.Cost, g, formatState(a.Next))
	}
}

func formatState(s State) string {
	return fmt.Sprintf("[node=%d fuel=%2d mask=%06b t=%2d]", s.Node, s.Fuel, s.Mask, s.Time)
}

func describeAction(sc *Scenario, a Action) string {
	switch a.Kind {
	case "wait":
		return fmt.Sprintf("wait until t=%d", a.Arrive)
	case "refuel":
		return fmt.Sprintf("refuel to %d (fee %d)", sc.FuelCap, a.Cost)
	case "drive", "discount":
		e := sc.Edges[a.Edge]
		s := fmt.Sprintf("drive #%d %d->%d [t=%d..%d] fuel -%d toll %d", a.Edge, e.From, e.To, a.Depart, a.Arrive, e.Fuel, e.Toll)
		if a.Kind == "discount" {
			s += fmt.Sprintf(" coupon#%d -%d => pay %d", e.Discount, sc.Discounts[e.Discount], a.Cost)
		}
		return s
	}
	return "?"
}

// demoScenario exercises every feature: coupons, time windows, a
// charging station with a capacity conflict, and waiting.
func demoScenario() *Scenario {
	return &Scenario{
		Nodes: 6, Start: 0, Goal: 5,
		FuelCap: 12, StartFuel: 12, Horizon: 40,
		Discounts: []int{5, 3},
		Edges: []Edge{
			{From: 0, To: 1, Fuel: 4, Time: 2, Toll: 8, Discount: 0},
			{From: 0, To: 2, Fuel: 6, Time: 4, Toll: 3, Discount: -1},
			{From: 1, To: 2, Fuel: 2, Time: 1, Toll: 1, Discount: -1},
			{From: 1, To: 3, Fuel: 5, Time: 3, Toll: 7, Windows: []Window{{Start: 6, End: 20}}, Discount: -1},
			{From: 2, To: 3, Fuel: 3, Time: 2, Toll: 6, Discount: 1},
			{From: 3, To: 4, Fuel: 4, Time: 2, Toll: 5, Discount: -1},
			{From: 3, To: 5, Fuel: 9, Time: 5, Toll: 2, Discount: -1},
			{From: 4, To: 5, Fuel: 2, Time: 1, Toll: 4, Windows: []Window{{Start: 0, End: 12}, {Start: 20, End: 30}}, Discount: -1},
		},
		Stations: []Station{
			{Node: 2, Fee: 2, Duration: 2, Capacity: 1, Occupancy: []int{0, 0, 0, 0, 1}},
		},
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}
