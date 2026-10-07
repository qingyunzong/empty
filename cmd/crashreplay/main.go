// Command crashreplay replays a log of write/sync/crash events and checks
// recovery invariants against every persistent subset of unsynced writes.
//
// Input is JSON lines, one event per line, possibly published out of order:
//
//	{"seq":1,"op":"write","key":"a","value":"1"}
//	{"seq":2,"op":"sync"}
//	{"seq":3,"op":"crash"}
//
// Output is a JSON report with verdict ok | counterexample | unknown.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"crashreplay"
)

func main() {
	file := flag.String("file", "", "event log (JSON lines); defaults to stdin")
	require := flag.String("require", "", "comma-separated key=value recovery requirements")
	budget := flag.Int("budget", crashreplay.DefaultBudget, "max persistent subsets enumerated per crash")
	seed := flag.Int64("seed", 1, "seed for the implementation's actual recovery")
	shuffle := flag.Bool("shuffle", true, "enumerate subsets in scrambled order")
	flag.Parse()

	events, err := readEvents(*file)
	if err != nil {
		fatal(err)
	}
	required, err := parseRequire(*require)
	if err != nil {
		fatal(err)
	}

	checker := crashreplay.Checker{Budget: *budget, Seed: *seed, Shuffle: *shuffle}
	report, err := checker.Check(events, crashreplay.Require(required))
	if err != nil {
		fatal(err)
	}

	out, _ := json.MarshalIndent(report, "", "  ")
	fmt.Println(string(out))

	switch report.Verdict {
	case crashreplay.VerdictOK:
		os.Exit(0)
	case crashreplay.VerdictCounterexample:
		os.Exit(1)
	default:
		os.Exit(2)
	}
}

func readEvents(file string) ([]crashreplay.Event, error) {
	var r io.Reader = os.Stdin
	if file != "" {
		f, err := os.Open(file)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	}
	var events []crashreplay.Event
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var e crashreplay.Event
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			return nil, fmt.Errorf("bad event %q: %w", line, err)
		}
		events = append(events, e)
	}
	return events, sc.Err()
}

func parseRequire(s string) (map[string]string, error) {
	required := map[string]string{}
	if s == "" {
		return required, nil
	}
	for _, pair := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(pair, "=")
		if !ok {
			return nil, fmt.Errorf("bad requirement %q, want key=value", pair)
		}
		required[k] = v
	}
	return required, nil
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "crashreplay:", err)
	os.Exit(3)
}
