// Command effectcheck infers read/write/throw effect sets for a program
// described in JSON and prints them with their source paths.
//
// Usage: effectcheck <program.json>
//
// JSON format:
//
//	{"functions": [
//	  {"name": "main", "locals": ["buf"], "body": [
//	    {"op": "read",   "region": "in",  "path": "src/main.ef:3"},
//	    {"op": "call",   "target": "put", "path": "src/main.ef:5"},
//	    {"op": "return", "region": "out", "path": "src/main.ef:7"}
//	  ]}
//	]}
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"

	"effectcheck"
)

type jsonProgram struct {
	Functions []jsonFunc `json:"functions"`
}

type jsonFunc struct {
	Name   string     `json:"name"`
	Locals []string   `json:"locals"`
	Body   []jsonStmt `json:"body"`
}

type jsonStmt struct {
	Op     string `json:"op"`
	Region string `json:"region,omitempty"`
	Target string `json:"target,omitempty"`
	Exc    string `json:"exc,omitempty"`
	Path   string `json:"path,omitempty"`
}

func toProgram(jp *jsonProgram) (*effectcheck.Program, error) {
	p := &effectcheck.Program{Funcs: make(map[string]*effectcheck.Func)}
	for _, jf := range jp.Functions {
		if _, dup := p.Funcs[jf.Name]; dup {
			return nil, fmt.Errorf("duplicate function %q", jf.Name)
		}
		f := &effectcheck.Func{Name: jf.Name, Locals: map[string]bool{}}
		for _, l := range jf.Locals {
			f.Locals[l] = true
		}
		for _, js := range jf.Body {
			st := effectcheck.Stmt{
				Region: js.Region,
				Target: js.Target,
				Exc:    js.Exc,
				Path:   js.Path,
			}
			switch js.Op {
			case "read":
				st.Kind = effectcheck.ReadStmt
			case "write":
				st.Kind = effectcheck.WriteStmt
			case "call":
				st.Kind = effectcheck.CallStmt
			case "throw":
				st.Kind = effectcheck.ThrowStmt
			case "return":
				st.Kind = effectcheck.ReturnStmt
			default:
				return nil, fmt.Errorf("function %q: unknown op %q", jf.Name, js.Op)
			}
			f.Body = append(f.Body, st)
		}
		p.Funcs[jf.Name] = f
	}
	return p, nil
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: effectcheck <program.json>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "effectcheck:", err)
		os.Exit(2)
	}
	var jp jsonProgram
	if err := json.Unmarshal(data, &jp); err != nil {
		fmt.Fprintln(os.Stderr, "effectcheck:", err)
		os.Exit(2)
	}
	prog, err := toProgram(&jp)
	if err != nil {
		fmt.Fprintln(os.Stderr, "effectcheck:", err)
		os.Exit(2)
	}

	res := effectcheck.Analyze(prog)

	names := make([]string, 0, len(res.Summaries))
	for name := range res.Summaries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		s := res.Summaries[name]
		fmt.Printf("function %s\n", name)
		for _, e := range effectcheck.SortedEffects(s.Reads) {
			fmt.Printf("  reads:   %s @ %s\n", e.Region, e.Path)
		}
		for _, e := range effectcheck.SortedEffects(s.Writes) {
			fmt.Printf("  writes:  %s @ %s\n", e.Region, e.Path)
		}
		for _, t := range effectcheck.SortedThrows(s.Throws) {
			fmt.Printf("  throws:  %s @ %s\n", t.Exc, t.Path)
		}
		for _, r := range effectcheck.SortedStrings(s.Returns) {
			fmt.Printf("  returns: %s\n", r)
		}
	}
	for _, d := range res.Diagnostics {
		fmt.Printf("diagnostic: %s\n", d.Message)
	}
	if len(res.Diagnostics) > 0 {
		os.Exit(1)
	}
}
