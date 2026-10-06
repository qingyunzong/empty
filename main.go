// Command bcchk validates half-open protected ranges for a bytecode
// instruction stream, prints the effective handler chain of every
// instruction, and optionally remaps range endpoints after a simulated
// instruction insertion. Fast table results are cross-checked against a
// naive per-range scan before printing.
//
// Usage: bcchk <spec.json>
//
// Spec format:
//
//	{
//	  "length": 16,
//	  "ranges": [{"start": 0, "end": 8, "handler": "A"}, ...],
//	  "insert": {"at": 3, "count": 2}   // optional
//	}
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"

	"bytecodecli/ranges"
)

type insertion struct {
	At    int `json:"at"`
	Count int `json:"count"`
}

type spec struct {
	Length int            `json:"length"`
	Ranges []ranges.Range `json:"ranges"`
	Insert *insertion     `json:"insert"`
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: bcchk <spec.json>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fatal(err)
	}
	var s spec
	if err := json.Unmarshal(data, &s); err != nil {
		fatal(fmt.Errorf("parsing spec: %w", err))
	}
	if s.Length < 0 {
		fatal(fmt.Errorf("negative program length %d", s.Length))
	}
	rs := ranges.WithOrder(s.Ranges)
	if err := printChains("handlers", rs, s.Length); err != nil {
		fatal(err)
	}
	if s.Insert != nil {
		if s.Insert.At < 0 || s.Insert.At > s.Length || s.Insert.Count < 0 {
			fatal(fmt.Errorf("invalid insertion at=%d count=%d for length %d",
				s.Insert.At, s.Insert.Count, s.Length))
		}
		rs = ranges.Remap(rs, s.Insert.At, s.Insert.Count)
		fmt.Printf("\nafter inserting %d instruction(s) at %d:\n", s.Insert.Count, s.Insert.At)
		for _, r := range rs {
			fmt.Printf("  range [%d,%d) -> %s\n", r.Start, r.End, r.Handler)
		}
		fmt.Println()
		if err := printChains("handlers", rs, s.Length+s.Insert.Count); err != nil {
			fatal(err)
		}
	}
}

// printChains prints the effective handler chain of every instruction,
// verifying the table index against the reference per-range scan.
func printChains(title string, rs []ranges.Range, length int) error {
	tab, err := ranges.NewTable(rs)
	if err != nil {
		return err
	}
	for pc := 0; pc < length; pc++ {
		chain := tab.ChainAt(pc)
		ref := ranges.ReferenceChainAt(rs, pc)
		if !reflect.DeepEqual(chain, ref) {
			return fmt.Errorf("internal mismatch at pc %d: table %v vs reference %v", pc, chain, ref)
		}
		fmt.Printf("pc=%-3d %s: %s\n", pc, title, chainString(chain))
	}
	return nil
}

func chainString(chain []ranges.Range) string {
	if len(chain) == 0 {
		return "(none)"
	}
	out := ""
	for i, r := range chain {
		if i > 0 {
			out += " > "
		}
		out += r.Handler
	}
	return out
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "bcchk:", err)
	os.Exit(1)
}
