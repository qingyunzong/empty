// cfgtrace inspects cfglib configuration files: it prints interpolated
// values, traces where each field's value came from, and cross-checks
// the merged-section inheritance model against the per-field recursive
// model.
//
// Usage:
//
//	cfgtrace get     <file> <section> <key>   print interpolated value
//	cfgtrace trace   <file> <section> <key>   show source & expansion chain
//	cfgtrace list    <file>                   list resolved fields + sources
//	cfgtrace compare <file>                   diff merged vs per-field models
package main

import (
	"fmt"
	"os"
	"strings"

	"example.com/cfglib/config"
)

func die(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "cfgtrace: "+format+"\n", args...)
	os.Exit(1)
}

func load(path string) (*config.Config, *config.Resolved) {
	f, err := os.Open(path)
	if err != nil {
		die("open %s: %v", path, err)
	}
	defer f.Close()
	cfg, err := config.Parse(f)
	if err != nil {
		die("parse %s: %v", path, err)
	}
	res, err := cfg.Resolve()
	if err != nil {
		die("resolve %s: %v", path, err)
	}
	return cfg, res
}

// traceField prints the origin and interpolation expansion tree for
// section.key. stack guards against infinite recursion; expansion
// errors (cycles, missing refs) are printed inline.
func traceField(cfg *config.Config, res *config.Resolved, section, key string, depth int, stack []string) {
	indent := strings.Repeat("  ", depth)
	id := section + "." + key
	f, ok := res.Field(section, key)
	if !ok {
		fmt.Printf("%s%s: MISSING (no such field after inheritance)\n", indent, id)
		return
	}
	origin := fmt.Sprintf("defined in [%s] line %d", f.Source, f.Line)
	if f.Source != section {
		if path := cfg.InheritancePath(section, f.Source); path != nil {
			origin += fmt.Sprintf(", inherited via %s", strings.Join(path, " -> "))
		}
	}
	fmt.Printf("%s%s\n%s  raw:    %q (%s)\n", indent, id, indent, f.Value, origin)
	for _, s := range stack {
		if s == id {
			fmt.Printf("%s  ^ interpolation cycle: %s -> %s\n", indent, strings.Join(stack, " -> "), id)
			return
		}
	}
	refs, err := config.References(f.Value)
	if err != nil {
		fmt.Printf("%s  error: %v\n", indent, err)
		return
	}
	for _, ref := range refs {
		rs, rk := splitRef(ref, section)
		traceField(cfg, res, rs, rk, depth+1, append(stack, id))
	}
	if depth == 0 {
		val, err := res.Get(section, key)
		if err != nil {
			fmt.Printf("final: ERROR: %v\n", err)
		} else {
			fmt.Printf("final: %s\n", val)
		}
	}
}

func splitRef(ref, local string) (string, string) {
	if i := strings.IndexByte(ref, '.'); i >= 0 {
		return ref[:i], ref[i+1:]
	}
	return local, ref
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: cfgtrace <get|trace|list|compare> <file> [section] [key]")
		os.Exit(2)
	}
	cmd, file := os.Args[1], os.Args[2]
	cfg, res := load(file)

	switch cmd {
	case "get":
		if len(os.Args) != 5 {
			die("get requires <file> <section> <key>")
		}
		v, err := res.Get(os.Args[3], os.Args[4])
		if err != nil {
			die("%v", err)
		}
		fmt.Println(v)

	case "trace":
		if len(os.Args) != 5 {
			die("trace requires <file> <section> <key>")
		}
		traceField(cfg, res, os.Args[3], os.Args[4], 0, nil)

	case "list":
		for _, sec := range res.Sections() {
			fmt.Printf("[%s]\n", sec)
			for _, k := range res.Keys(sec) {
				f, _ := res.Field(sec, k)
				v, err := res.Get(sec, k)
				if err != nil {
					v = "ERROR: " + err.Error()
				}
				fmt.Printf("  %-12s = %-24s (raw %q from [%s] line %d)\n", k, v, f.Value, f.Source, f.Line)
			}
		}

	case "compare":
		diffs := res.CompareModels()
		if len(diffs) == 0 {
			fmt.Println("merged-section model and per-field recursive model agree on all fields")
			return
		}
		for _, d := range diffs {
			fmt.Println("DIFF:", d)
		}
		os.Exit(1)

	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n", cmd)
		os.Exit(2)
	}
}
