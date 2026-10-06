// Command jsonround reads a JSON array of numbers from stdin and converts
// each to an integer at a fixed decimal scale using exact decimal
// arithmetic with round-half-even. With -cumul it instead emits per-row
// cumulative-rounding deltas; -withdraw removes rows before computing.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"strconv"
	"strings"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("jsonround", flag.ContinueOnError)
	fs.SetOutput(stderr)
	scale := fs.Int("scale", 2, "decimal places to quantize to")
	cumul := fs.Bool("cumul", false, "emit per-row cumulative rounding deltas")
	withdraw := fs.String("withdraw", "", "comma-separated row indices to withdraw (cumul mode)")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	dec := json.NewDecoder(stdin)
	dec.UseNumber()
	var raw []json.Number
	if err := dec.Decode(&raw); err != nil {
		fmt.Fprintf(stderr, "error: invalid JSON input: %v\n", err)
		return 1
	}

	literals := make([]string, len(raw))
	for i, n := range raw {
		literals[i] = n.String()
	}

	if !*cumul {
		out, errs := ConvertAll(literals, *scale)
		if len(errs) > 0 {
			for _, e := range errs {
				fmt.Fprintf(stderr, "error: %v\n", e)
			}
			return 1
		}
		return writeInts(stdout, out)
	}

	col := NewColumn(*scale)
	var errs []PosError
	for i, lit := range literals {
		d, err := Parse(lit)
		if err != nil {
			errs = append(errs, PosError{Index: i, Err: err})
			continue
		}
		col.Append(d)
	}
	if len(errs) > 0 {
		for _, e := range errs {
			fmt.Fprintf(stderr, "error: %v\n", e)
		}
		return 1
	}
	if *withdraw != "" {
		// Withdraw from the highest index downward so positions refer to
		// the original row numbering.
		var idxs []int
		for _, tok := range strings.Split(*withdraw, ",") {
			i, err := strconv.Atoi(strings.TrimSpace(tok))
			if err != nil || i < 0 || i >= col.Len() {
				fmt.Fprintf(stderr, "error: invalid withdraw index %q\n", tok)
				return 1
			}
			idxs = append(idxs, i)
		}
		for i := 0; i < len(idxs); i++ {
			for j := i + 1; j < len(idxs); j++ {
				if idxs[j] == idxs[i] {
					fmt.Fprintf(stderr, "error: duplicate withdraw index %d\n", idxs[i])
					return 1
				}
				if idxs[j] < idxs[i] {
					idxs[i], idxs[j] = idxs[j], idxs[i]
				}
			}
		}
		for k := len(idxs) - 1; k >= 0; k-- {
			col.Withdraw(idxs[k])
		}
	}
	return writeInts(stdout, col.Deltas())
}

func writeInts(w io.Writer, vals []*big.Int) int {
	out, err := json.Marshal(vals)
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		return 1
	}
	fmt.Fprintln(w, string(out))
	return 0
}
