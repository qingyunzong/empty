// Command regalloc computes a minimum-cost register allocation for up to
// 16 live intervals and up to 4 registers. Call sites may reserve
// registers; spilling incurs per-interval load/store costs. It prints a
// per-point occupancy certificate plus the spill load/store events, and
// can exhaustively cross-check small instances.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
)

func main() {
	inputPath := flag.String("i", "", "input JSON file (default: stdin)")
	format := flag.String("f", "text", "output format: text, json, or events")
	check := flag.Bool("check", false, "cross-check optimum by exhaustive enumeration (small instances)")
	flag.Parse()

	var r io.Reader = os.Stdin
	if *inputPath != "" {
		f, err := os.Open(*inputPath)
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		r = f
	}
	data, err := io.ReadAll(r)
	if err != nil {
		fatal(err)
	}
	var in Input
	if err := json.Unmarshal(data, &in); err != nil {
		fatal(fmt.Errorf("parsing input: %w", err))
	}

	sol, err := solveInstance(&in)
	if err != nil {
		fatal(err)
	}
	if err := Verify(&in, sol); err != nil {
		fatal(fmt.Errorf("internal certificate verification failed: %w", err))
	}

	switch *format {
	case "json":
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(sol); err != nil {
			fatal(err)
		}
	case "text":
		printText(&in, sol)
	case "events":
		for _, e := range sol.Events {
			fmt.Printf("p%d %s %s cost=%d\n", e.Point, e.Op, e.Interval, e.Cost)
		}
		fmt.Printf("total cost: %d\n", sol.TotalCost)
	default:
		fatal(fmt.Errorf("unknown format %q", *format))
	}

	if *check {
		bf, err := bruteForce(&in)
		if err != nil {
			fmt.Fprintf(os.Stderr, "exhaustive check skipped: %v\n", err)
		} else if bf != sol.TotalCost {
			fatal(fmt.Errorf("MISMATCH: DP cost %d, exhaustive cost %d", sol.TotalCost, bf))
		} else {
			fmt.Fprintf(os.Stderr, "exhaustive check: OK (optimum %d confirmed)\n", bf)
		}
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func printText(in *Input, sol *Solution) {
	fmt.Printf("total cost: %d\n", sol.TotalCost)
	fmt.Println("per-point occupancy:")
	for _, ps := range sol.Points {
		regs := make([]string, 0, len(ps.Occupancy))
		for r := range ps.Occupancy {
			regs = append(regs, r)
		}
		sort.Strings(regs)
		line := fmt.Sprintf("  p%-3d", ps.Point)
		for _, r := range regs {
			line += fmt.Sprintf(" %s=%s", r, ps.Occupancy[r])
		}
		if len(ps.Spilled) > 0 {
			line += fmt.Sprintf("  spilled=%v", ps.Spilled)
		}
		if len(ps.Reserved) > 0 {
			line += fmt.Sprintf("  reserved=%v", ps.Reserved)
		}
		fmt.Println(line)
	}
	fmt.Println("spill/reload events:")
	if len(sol.Events) == 0 {
		fmt.Println("  (none)")
	}
	for _, e := range sol.Events {
		fmt.Printf("  p%-3d %-5s %-4s cost=%d\n", e.Point, e.Op, e.Interval, e.Cost)
	}
}
