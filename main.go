// Command ifacheck analyzes a finite interface type graph and answers
// structural subtyping queries. Recursive types are interpreted
// coinductively (greatest fixed point). For incompatible pairs it prints
// the shortest member path to the failure.
//
// Input is JSON read from a file argument or stdin ("-"):
//
//	{
//	  "types": {
//	    "Animal": {"fields": {"name": "string"},
//	               "methods": {"speak": {"params": [], "result": "string"}}},
//	    "Pet":    {"fields": {"name": "string", "owner": "string"},
//	               "methods": {"speak": {"params": [], "result": "string"}}}
//	  },
//	  "queries": [{"sub": "Pet", "super": "Animal"}]
//	}
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
)

func main() {
	verify := flag.Bool("verify", false, "cross-check acyclic queries against the expansion reference model")
	flag.Parse()

	var r io.Reader = os.Stdin
	if flag.NArg() > 1 {
		fmt.Fprintln(os.Stderr, "usage: ifacheck [-verify] [input.json|-]")
		os.Exit(2)
	}
	if flag.NArg() == 1 && flag.Arg(0) != "-" {
		f, err := os.Open(flag.Arg(0))
		if err != nil {
			fmt.Fprintln(os.Stderr, "error:", err)
			os.Exit(2)
		}
		defer f.Close()
		r = f
	}
	data, err := io.ReadAll(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error reading input:", err)
		os.Exit(2)
	}
	var doc Document
	if err := json.Unmarshal(data, &doc); err != nil {
		fmt.Fprintln(os.Stderr, "error parsing JSON:", err)
		os.Exit(2)
	}
	env, err := NewEnv(doc.Types)
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid type graph:", err)
		os.Exit(2)
	}
	checker := NewChecker(env)

	failures := 0
	for _, q := range doc.Queries {
		if checker.Compatible(q.Sub, q.Super) {
			fmt.Printf("OK   %s <: %s\n", q.Sub, q.Super)
		} else {
			failures++
			path, reason, _ := checker.ShortestFailure(q.Sub, q.Super)
			fmt.Printf("FAIL %s <: %s at %s: %s\n", q.Sub, q.Super, strings.Join(path, ""), reason)
		}
		if *verify {
			ref, err := VerifyAcyclic(env, checker, q)
			if err != nil {
				fmt.Printf("     verify: %v\n", err)
			} else {
				fmt.Printf("     verify: reference model agrees (result=%v)\n", ref)
			}
		}
	}
	if failures > 0 {
		os.Exit(1)
	}
}
