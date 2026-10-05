package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
)

func main() {
	scenarioName := flag.String("scenario", "small", "built-in scenario name")
	list := flag.Bool("list", false, "list available scenarios and exit")
	evidenceMode := flag.String("evidence", "full", "evidence output: full|summary")
	enumerate := flag.Bool("enumerate", true, "exhaustively enumerate all subsequences to cross-check minimality")
	enumPrintLimit := flag.Int("enum-print-limit", 4096, "max enumeration evidence lines printed (summary beyond this)")
	flag.Parse()

	if *list {
		names := make([]string, 0, len(scenarios))
		for name := range scenarios {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			s := scenarios[name]
			fmt.Printf("%-12s %2d events  target=%s\n", name, len(s.Events), s.Target)
		}
		return
	}

	s, ok := scenarios[*scenarioName]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown scenario %q (use -list)\n", *scenarioName)
		os.Exit(2)
	}
	if err := s.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "invalid scenario: %v\n", err)
		os.Exit(2)
	}

	fmt.Printf("scenario: %s (%d events, cap %d), target=%q, initial=%v\n",
		s.Name, len(s.Events), MaxEvents, s.Target, s.Initial)
	for i, e := range s.Events {
		fmt.Printf("  event %2d: %-10s reads=%v writes=%v\n", i, e.ID, e.Reads, e.Writes)
	}

	// Phase 1: minimum failing subsequence search with full detection evidence.
	var ev Evidence
	result := MinFailing(s, &ev)
	fmt.Printf("\n== phase 1: minimization search (%d candidates checked) ==\n", len(ev.Checks))
	printEvidence(s, ev.Checks, *evidenceMode)
	if result == nil {
		fmt.Println("result: NO failing subsequence exists")
	} else {
		fmt.Printf("result: minimum failing subsequence size=%d %s\n", len(result), s.SubIDs(result))
		fmt.Printf("1-minimal (every single-event removal breaks the failure): %v\n", IsOneMinimal(s, result))
	}

	// Phase 2: exhaustive enumeration cross-check.
	if !*enumerate {
		return
	}
	var enumEv Evidence
	failing := EnumerateAll(s, &enumEv)
	fmt.Printf("\n== phase 2: exhaustive enumeration (%d subsequences, %d failing) ==\n",
		len(enumEv.Checks), len(failing))
	if len(enumEv.Checks) <= *enumPrintLimit {
		printEvidence(s, enumEv.Checks, *evidenceMode)
	} else {
		fmt.Printf("(evidence too large to print: %d lines; summary only)\n", len(enumEv.Checks))
	}
	enumMin := MinSize(failing)
	switch {
	case result == nil && enumMin < 0:
		fmt.Println("cross-check: OK (both agree no failing subsequence exists)")
	case result == nil || enumMin < 0:
		fmt.Printf("cross-check: MISMATCH (search=%v, enumeration min=%d)\n", result != nil, enumMin)
		os.Exit(1)
	case len(result) == enumMin:
		fmt.Printf("cross-check: OK (both agree minimum size = %d)\n", enumMin)
	default:
		fmt.Printf("cross-check: MISMATCH (search=%d, enumeration=%d)\n", len(result), enumMin)
		os.Exit(1)
	}
}

func printEvidence(s Scenario, checks []Check, mode string) {
	legal, failed := 0, 0
	for i, c := range checks {
		if c.Legal {
			legal++
		}
		if c.Fail {
			failed++
		}
		if mode == "full" {
			fmt.Printf("  check %4d: %-40s legal=%-5v fail=%v\n", i+1, s.SubIDs(c.Sub), c.Legal, c.Fail)
		}
	}
	fmt.Printf("  totals: %d checked, %d legal, %d failing\n", len(checks), legal, failed)
}
