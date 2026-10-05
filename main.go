// Command berthsched schedules up to 12 ships onto a single length-limited
// berth, choosing discrete candidate start times subject to tidal windows,
// minimizing total waiting time. All times are absolute minutes, so service
// intervals may cross midnight. Occupancy is reported as half-open [s, e).
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
)

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	fs := flag.NewFlagSet("berthsched", flag.ContinueOnError)
	input := fs.String("i", "", "input JSON file (default: stdin)")
	asJSON := fs.Bool("json", false, "emit the solution as JSON")
	brute := fs.Bool("brute", false, "also solve by full enumeration and cross-check")
	if err := fs.Parse(args); err != nil {
		return err
	}

	var data []byte
	var err error
	if *input != "" {
		data, err = os.ReadFile(*input)
	} else {
		data, err = io.ReadAll(stdin)
	}
	if err != nil {
		return err
	}
	var p Problem
	if err := json.Unmarshal(data, &p); err != nil {
		return fmt.Errorf("parsing input: %w", err)
	}

	sol, err := Solve(&p)
	if err != nil {
		return err
	}
	if *brute {
		ref, err := BruteForce(&p)
		if err != nil {
			return fmt.Errorf("brute-force cross-check: %w", err)
		}
		if ref.TotalWait != sol.TotalWait || ref.Makespan != sol.Makespan {
			return fmt.Errorf("cross-check mismatch: solver wait=%d makespan=%d, brute force wait=%d makespan=%d",
				sol.TotalWait, sol.Makespan, ref.TotalWait, ref.Makespan)
		}
		fmt.Fprintf(stdout, "brute-force cross-check: OK (wait=%d, makespan=%d)\n", sol.TotalWait, sol.Makespan)
	}

	if *asJSON {
		type outAssign struct {
			Ship  string `json:"ship"`
			Start int    `json:"start"`
			End   int    `json:"end"`
			Wait  int    `json:"wait"`
		}
		out := struct {
			TotalWait   int         `json:"total_wait"`
			Makespan    int         `json:"makespan"`
			Assignments []outAssign `json:"assignments"`
		}{TotalWait: sol.TotalWait, Makespan: sol.Makespan}
		for _, a := range sol.Assignments {
			out.Assignments = append(out.Assignments, outAssign{
				Ship: p.Ships[a.ShipIndex].ID, Start: a.Start, End: a.End, Wait: a.Wait,
			})
		}
		enc := json.NewEncoder(stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(out)
	}

	fmt.Fprintf(stdout, "total wait: %d min, makespan ends at %s (t=%d)\n", sol.TotalWait, fmtAbs(sol.Makespan), sol.Makespan)
	for _, a := range sol.Assignments {
		s := p.Ships[a.ShipIndex]
		fmt.Fprintf(stdout, "  %-10s occupy [%4d, %4d)  %s .. %s  wait=%d min\n",
			s.ID, a.Start, a.End, fmtAbs(a.Start), fmtAbs(a.End), a.Wait)
	}
	return nil
}
