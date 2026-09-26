// ratecalc replays a JSONL telemetry fixture and prints per-window rates.
package main

import (
	"flag"
	"fmt"
	"os"
	"time"

	"counterrate"
)

func main() {
	file := flag.String("file", "", "JSONL fixture path (required)")
	window := flag.Duration("window", time.Minute, "rate window length")
	step := flag.Duration("step", 0, "window step (default: window length)")
	policy := flag.String("policy", "last", "conflict policy: last|first|max|error")
	flag.Parse()

	if *file == "" {
		fmt.Fprintln(os.Stderr, "usage: ratecalc -file fixture.jsonl [-window 1m] [-step 1m] [-policy last]")
		os.Exit(2)
	}
	policies := map[string]counterrate.ConflictPolicy{
		"last":  counterrate.ConflictLastWins,
		"first": counterrate.ConflictFirstWins,
		"max":   counterrate.ConflictMaxWins,
		"error": counterrate.ConflictError,
	}
	pol, ok := policies[*policy]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown policy %q\n", *policy)
		os.Exit(2)
	}
	if *step <= 0 {
		*step = *window
	}

	f, err := os.Open(*file)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer f.Close()

	s := counterrate.NewSeries(pol)
	n, err := counterrate.ReplayFixture(f, s)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	segs, err := s.Resolve()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if len(segs) == 0 {
		fmt.Println("no samples")
		return
	}
	first := segs[0][0].Ts
	last := segs[len(segs)-1][len(segs[len(segs)-1])-1].Ts
	fmt.Printf("replayed %d samples, %d segment(s), %d conflict(s), span %s .. %s\n",
		n, len(segs), s.Conflicts, first.Format(time.RFC3339), last.Format(time.RFC3339))

	for w := first; w.Before(last); w = w.Add(*step) {
		end := w.Add(*window)
		if end.After(last) {
			end = last
		}
		r, err := s.WindowRate(w, end)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		flagStr := ""
		if r.Uncertain {
			flagStr = " UNCERTAIN(unmarked-reset)"
		}
		fmt.Printf("[%s .. %s] rate=%8.4f/s increase=%8.1f resets=%d samples=%d%s\n",
			w.Format("15:04:05"), end.Format("15:04:05"), r.Rate, r.Increase, r.Resets, r.Samples, flagStr)
	}
}
