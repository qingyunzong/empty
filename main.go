package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
)

func main() {
	dump := flag.Bool("dump", false, "print a verdict row for every subsequence (full enumeration evidence)")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "usage: scenariomin [-dump] <scenario.json>\n")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() != 1 {
		flag.Usage()
		os.Exit(2)
	}
	sc, err := LoadScenario(flag.Arg(0))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(2)
	}
	os.Exit(run(sc, *dump, os.Stdout))
}

func eventIDs(s *Scenario, idx []int) string {
	ids := make([]string, len(idx))
	for i, k := range idx {
		ids[i] = s.Events[k].ID
	}
	return "[" + strings.Join(ids, " ") + "]"
}

// run executes the minimization and prints the full detection evidence.
func run(s *Scenario, dump bool, w io.Writer) int {
	fmt.Fprintf(w, "scenario %q: %d events, victim %s\n", s.Name, len(s.Events), s.Victim)
	fullIdx := allIndices(len(s.Events))
	fullTrace := simulate(s.Events, fullIdx)
	fullFails, _ := s.fails(fullIdx)
	fmt.Fprintf(w, "full sequence %s: legal=%v fails=%v\n", eventIDs(s, fullIdx), fullTrace.legal, fullFails)

	res := Minimize(s)
	fmt.Fprintln(w, "search evidence (subsequences checked per size):")
	fmt.Fprintln(w, "  size  total  legal  failing")
	for _, st := range res.Stats {
		marker := ""
		if st.Size == res.MinimalSize {
			marker = "  <-- minimal failing size"
		}
		fmt.Fprintf(w, "  %4d  %5d  %5d  %7d%s\n", st.Size, st.Total, st.Legal, st.Failing, marker)
	}

	if !res.Found {
		fmt.Fprintln(w, "no failing subsequence found")
		return 1
	}

	fmt.Fprintf(w, "minimal failing subsequence (size %d): %s\n", res.MinimalSize, eventIDs(s, res.Witness))
	if res.MinimalCount > 1 {
		fmt.Fprintf(w, "note: %d distinct failing subsequences exist at the minimal size; showing the first\n", res.MinimalCount)
	}

	fmt.Fprintln(w, "legality trace of the witness:")
	wt := simulate(s.Events, res.Witness)
	for _, k := range res.Witness {
		ev := s.Events[k]
		var parts []string
		for _, b := range wt.bindings {
			if b.eventID == ev.ID {
				parts = append(parts, fmt.Sprintf("reads %s <- %s (ok)", b.resource, b.writer))
			}
		}
		for _, wr := range ev.Writes {
			parts = append(parts, "writes "+wr)
		}
		if len(parts) == 0 {
			parts = append(parts, "(no resource access)")
		}
		fmt.Fprintf(w, "  %s: %s\n", ev.ID, strings.Join(parts, "; "))
	}

	fmt.Fprintln(w, "failure evidence (victim reads vs declared bad writers):")
	obs := observation(wt, s.Victim)
	resources := make([]string, 0, len(obs))
	for r := range obs {
		resources = append(resources, r)
	}
	sort.Strings(resources)
	for _, r := range resources {
		verdict := "ok"
		if s.badWriter(r, obs[r]) {
			verdict = fmt.Sprintf("declared bad %v => failure", s.Fail[r])
		}
		fmt.Fprintf(w, "  resource %s: last writer %s (%s)\n", r, obs[r], verdict)
	}

	fmt.Fprintf(w, "minimality: all %d legal subsequences of size < %d pass (0 failing); checked exhaustively\n",
		res.LegalBelowMin, res.MinimalSize)

	if dump {
		rows := Enumerate(s)
		fmt.Fprintf(w, "full enumeration evidence (%d subsequences):\n", len(rows))
		for _, row := range rows {
			fmt.Fprintf(w, "  %-28s legal=%-5v failing=%-5v %s\n", eventIDs(s, row.Indices), row.Legal, row.Failing, row.Note)
		}
	}
	return 0
}
