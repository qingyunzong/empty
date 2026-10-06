// Command jsonnum reads a JSON array of numbers from stdin and converts each
// number to an integer at a fixed decimal scale using round-half-to-even,
// with the decimal exponent evaluated exactly (no float64).
//
// Usage:
//
//	jsonnum -scale 2 [-mode convert|cumulative] < numbers.json
//
// In convert mode each element becomes its rounded integer. In cumulative
// mode the output is the column of cumulative-rounding deltas: the sum of
// the first k outputs equals round-half-even of the exact sum of the first
// k inputs. Integers are emitted as JSON strings to preserve precision.
// Out-of-range literals (|exponent| > 1000) are rejected with their index
// reported, and the exit code is 1.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"

	"jsonnum/cumround"
	"jsonnum/decimal"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("jsonnum", flag.ContinueOnError)
	fs.SetOutput(stderr)
	scale := fs.Int("scale", 2, "decimal places of the output integers")
	mode := fs.String("mode", "convert", "convert: per-number rounding; cumulative: column cumulative-rounding deltas")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if err := decimal.CheckScale(*scale); err != nil {
		fmt.Fprintf(stderr, "jsonnum: %v\n", err)
		return 2
	}

	dec := json.NewDecoder(stdin)
	dec.UseNumber()
	var raw []json.Number
	if err := dec.Decode(&raw); err != nil {
		fmt.Fprintf(stderr, "jsonnum: invalid JSON input: %v\n", err)
		return 1
	}

	nums := make([]*decimal.Num, len(raw))
	ok := true
	for i, jn := range raw {
		n, err := decimal.Parse(jn.String())
		if err != nil {
			fmt.Fprintf(stderr, "jsonnum: index %d: %v\n", i, err)
			ok = false
			continue
		}
		nums[i] = n
	}
	if !ok {
		return 1
	}

	var out []string
	switch *mode {
	case "convert":
		out = make([]string, len(nums))
		for i, n := range nums {
			out[i] = decimal.Quantize(n, *scale).String()
		}
	case "cumulative":
		amounts := make([]*big.Rat, len(nums))
		for i, n := range nums {
			amounts[i] = n.Rat()
		}
		deltas := cumround.Deltas(amounts, *scale)
		out = make([]string, len(deltas))
		for i, d := range deltas {
			out[i] = d.String()
		}
	default:
		fmt.Fprintf(stderr, "jsonnum: unknown mode %q\n", *mode)
		return 2
	}

	enc := json.NewEncoder(stdout)
	if err := enc.Encode(out); err != nil {
		fmt.Fprintf(stderr, "jsonnum: %v\n", err)
		return 1
	}
	return 0
}
