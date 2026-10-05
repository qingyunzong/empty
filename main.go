package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"os"
)

func usage() {
	fmt.Fprintf(os.Stderr, `router - minimum-cost routing CLI over a finite state graph

State: (node<=10, integer fuel<=20, 6 one-time coupons, station charging
slots, time<=60). Toll = base + (maxFuel-fuel)/2, non-negative.

Commands:
  solve      -graph g.json [-cert out.json] [-no-prune] [-max-steps N]
               [-checkpoint cp.json] [-resume cp.json]
  verify     -graph g.json -cert c.json
  exhaustive -graph g.json          (independent brute-force cross-check)
  gen        -nodes N -seed S [-grid RxC] [-stations K] [-coupons K] -out g.json
`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "solve":
		err = cmdSolve(os.Args[2:])
	case "verify":
		err = cmdVerify(os.Args[2:])
	case "exhaustive":
		err = cmdExhaustive(os.Args[2:])
	case "gen":
		err = cmdGen(os.Args[2:])
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func cmdSolve(args []string) error {
	fs := flag.NewFlagSet("solve", flag.ContinueOnError)
	graphPath := fs.String("graph", "", "graph JSON file")
	certPath := fs.String("cert", "", "write certificate JSON here")
	noPrune := fs.Bool("no-prune", false, "disable dominance pruning (cross-check)")
	maxSteps := fs.Int("max-steps", 0, "pause after N expansions (0 = no limit)")
	cpPath := fs.String("checkpoint", "", "write frontier checkpoint here when pausing")
	resumePath := fs.String("resume", "", "resume from a checkpoint file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	g, err := LoadGraph(*graphPath)
	if err != nil {
		return err
	}
	var s *Solver
	if *resumePath != "" {
		data, err := os.ReadFile(*resumePath)
		if err != nil {
			return err
		}
		var cp Checkpoint
		if err := json.Unmarshal(data, &cp); err != nil {
			return fmt.Errorf("parse checkpoint: %w", err)
		}
		s = Resume(g, *noPrune, &cp)
		fmt.Printf("resumed from %s (steps so far: %d, frontier: %d)\n", *resumePath, cp.Steps, len(cp.Heap))
	} else {
		s = NewSolver(g, *noPrune)
	}
	s.Run(*maxSteps)
	if !s.Done {
		if *cpPath == "" {
			return fmt.Errorf("search paused after %d expansions but no -checkpoint file given", *maxSteps)
		}
		cp := s.Save()
		data, _ := json.MarshalIndent(cp, "", "  ")
		if err := os.WriteFile(*cpPath, data, 0o644); err != nil {
			return err
		}
		fmt.Printf("paused: steps=%d frontier=%d settled=%d checkpoint=%s\n",
			s.Steps, len(cp.Heap), len(cp.Settled), *cpPath)
		return nil
	}
	if !s.Found {
		fmt.Printf("no feasible route to node %d within time %d (steps=%d)\n", g.Goal, g.MaxTime, s.Steps)
		return nil
	}
	cert := BuildCertificate(s)
	fmt.Printf("optimal cost (lower bound): %d  (steps=%d, pruned=%v)\n", cert.LowerBound, s.Steps, !*noPrune)
	for _, st := range cert.Steps {
		fmt.Printf("  step %d: %-8s edge=%d station=%d amount=%d coupon=%v cost=%d cumulative=%d\n",
			st.Index, st.Action, st.Edge, st.Station, st.Amount, st.UseCoupon, st.Cost, st.Cumulative)
		fmt.Printf("    from node=%d fuel=%d time=%d coupons=%v slots=%v\n",
			st.From.Node, st.From.Fuel, st.From.Time, st.From.Coupons, st.From.Slots)
		fmt.Printf("    to   node=%d fuel=%d time=%d coupons=%v slots=%v\n",
			st.To.Node, st.To.Fuel, st.To.Time, st.To.Coupons, st.To.Slots)
	}
	if *certPath != "" {
		data, _ := json.MarshalIndent(cert, "", "  ")
		if err := os.WriteFile(*certPath, data, 0o644); err != nil {
			return err
		}
		fmt.Printf("certificate written to %s\n", *certPath)
	}
	return nil
}

func cmdVerify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	graphPath := fs.String("graph", "", "graph JSON file")
	certPath := fs.String("cert", "", "certificate JSON file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	g, err := LoadGraph(*graphPath)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(*certPath)
	if err != nil {
		return err
	}
	var cert Certificate
	if err := json.Unmarshal(data, &cert); err != nil {
		return fmt.Errorf("parse certificate: %w", err)
	}
	if err := VerifyCertificate(g, &cert); err != nil {
		return fmt.Errorf("certificate replay failed: %w", err)
	}
	// Independent optimality check: recompute the optimum from scratch.
	s := NewSolver(g, false)
	s.Run(0)
	if !s.Found {
		return fmt.Errorf("certificate claims cost %d but no feasible route exists", cert.Cost)
	}
	if s.Best != cert.Cost {
		return fmt.Errorf("certificate cost %d is not optimal; lower bound is %d", cert.Cost, s.Best)
	}
	fmt.Printf("certificate valid: cost %d equals the optimal lower bound (%d steps replayed)\n",
		cert.Cost, len(cert.Steps))
	return nil
}

func cmdExhaustive(args []string) error {
	fs := flag.NewFlagSet("exhaustive", flag.ContinueOnError)
	graphPath := fs.String("graph", "", "graph JSON file")
	if err := fs.Parse(args); err != nil {
		return err
	}
	g, err := LoadGraph(*graphPath)
	if err != nil {
		return err
	}
	cost, found := Exhaustive(g)
	if !found {
		fmt.Println("exhaustive search: no feasible route")
		return nil
	}
	fmt.Printf("exhaustive search optimum: %d\n", cost)
	return nil
}

func cmdGen(args []string) error {
	fs := flag.NewFlagSet("gen", flag.ContinueOnError)
	nodes := fs.Int("nodes", 6, "number of nodes (ignored with -grid)")
	grid := fs.String("grid", "", "grid dimensions RxC, e.g. 2x3")
	seed := fs.Int64("seed", 1, "random seed")
	stations := fs.Int("stations", 2, "number of supply stations")
	coupons := fs.Int("coupons", MaxCoupons, "coupon indices in use (0..6)")
	extra := fs.Int("extra-edges", 0, "extra random edges beyond the spanning chain")
	maxFuel := fs.Int("max-fuel", MaxFuelCap, "fuel capacity")
	maxTime := fs.Int("max-time", MaxTimeCap, "time horizon")
	out := fs.String("out", "", "output file (stdout if empty)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg := GenConfig{
		Nodes: *nodes, MaxFuel: *maxFuel, MaxTime: *maxTime,
		Coupons: *coupons, Stations: *stations, ExtraEdges: *extra,
	}
	if *grid != "" {
		if _, err := fmt.Sscanf(*grid, "%dx%d", &cfg.GridRows, &cfg.GridCols); err != nil {
			return fmt.Errorf("bad -grid %q, want RxC", *grid)
		}
	}
	g := RandomGraph(rand.New(rand.NewSource(*seed)), cfg)
	if err := g.Validate(); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(g, "", "  ")
	if *out == "" {
		fmt.Println(string(data))
		return nil
	}
	return os.WriteFile(*out, data, 0o644)
}
