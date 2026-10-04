// Command cfg resolves config files with section inheritance and field
// interpolation, and traces where every final value comes from.
//
// Usage:
//
//	cfg get     <file> <section> <field>   print the final value
//	cfg dump    <file> [section]           print final resolved fields
//	cfg trace   <file> <section> <field>   explain the provenance of a value
//	cfg compare <file> [section]           contrast flatten vs per-field
//	                                       recursive inheritance models
package main

import (
	"fmt"
	"os"

	"cfg"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  cfg get     <file> <section> <field>   print the final value
  cfg dump    <file> [section]           print final resolved fields
  cfg trace   <file> <section> <field>   explain the provenance of a value
  cfg compare <file> [section]           flatten vs per-field recursive model`)
	os.Exit(2)
}

func load(path string) *cfg.Config {
	c, err := cfg.ParseFile(path)
	if err != nil {
		fatal(err)
	}
	return c
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 3 {
		usage()
	}
	cmd, file := os.Args[1], os.Args[2]
	args := os.Args[3:]
	switch cmd {
	case "get":
		if len(args) != 2 {
			usage()
		}
		c := load(file)
		if err := c.Resolve(); err != nil {
			fatal(err)
		}
		sec, ok := c.Sections[args[0]]
		if !ok {
			fatal(fmt.Errorf("missing section %q", args[0]))
		}
		v, ok := sec.Values[args[1]]
		if !ok {
			fatal(fmt.Errorf("missing field %q in section %q", args[1], args[0]))
		}
		fmt.Println(v)
	case "dump":
		c := load(file)
		if err := c.Resolve(); err != nil {
			fatal(err)
		}
		dumpAll(c, args)
	case "trace":
		if len(args) != 2 {
			usage()
		}
		c := load(file)
		if err := c.Resolve(); err != nil {
			fatal(err)
		}
		tr, err := c.TraceField(args[0], args[1])
		if err != nil {
			fatal(err)
		}
		fmt.Print(tr.String())
	case "compare":
		c := load(file)
		diffs, err := c.CompareModels()
		if err != nil {
			fatal(err)
		}
		want := ""
		if len(args) == 1 {
			want = args[0]
		}
		shown := 0
		for _, d := range diffs {
			if want != "" && d.Ref.Section != want {
				continue
			}
			fmt.Printf("%s\n  flatten:   %s\n  recursive: %s\n", d.Ref, d.Flatten, d.Recursive)
			shown++
		}
		if shown == 0 {
			fmt.Println("both models agree on every field")
		}
	default:
		usage()
	}
}

func dumpAll(c *cfg.Config, only []string) {
	names := only
	if len(names) == 0 {
		for name := range c.Sections {
			names = append(names, name)
		}
	}
	// deterministic order
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			if names[j] < names[i] {
				names[i], names[j] = names[j], names[i]
			}
		}
	}
	for _, name := range names {
		sec, ok := c.Sections[name]
		if !ok {
			fatal(fmt.Errorf("missing section %q", name))
		}
		fmt.Printf("[%s]\n", name)
		for _, f := range cfg.SortedFields(sec.Values) {
			fmt.Printf("%s = %s\n", f, sec.Values[f])
		}
	}
}
