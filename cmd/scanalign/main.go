// Command scanalign aligns an expected tool-input sequence with the actually
// scanned barcode sequence and prints a minimal, replayable delete/insert
// edit script.
package main

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"scanalign/align"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("scanalign", flag.ContinueOnError)
	fs.SetOutput(stderr)
	editsOnly := fs.Bool("edits-only", false, "print only del/ins operations, omit keep lines")
	fs.Usage = func() {
		fmt.Fprintln(stderr, "usage: scanalign [-edits-only] <expected-file> <scanned-file>")
		fmt.Fprintln(stderr, "each file lists one barcode per line; use - for stdin")
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 2 {
		fs.Usage()
		return 2
	}
	if fs.Arg(0) == "-" && fs.Arg(1) == "-" {
		fmt.Fprintln(stderr, "scanalign: only one input may be stdin")
		return 2
	}
	expected, err := readItems(fs.Arg(0), stdin)
	if err != nil {
		fmt.Fprintln(stderr, "scanalign:", err)
		return 1
	}
	scanned, err := readItems(fs.Arg(1), stdin)
	if err != nil {
		fmt.Fprintln(stderr, "scanalign:", err)
		return 1
	}

	ops := align.Diff(expected, scanned)
	dels, ins := 0, 0
	shown := make([]align.Op, 0, len(ops))
	for _, op := range ops {
		switch op.Kind {
		case align.Del:
			dels++
			shown = append(shown, op)
		case align.Ins:
			ins++
			shown = append(shown, op)
		default:
			if !*editsOnly {
				shown = append(shown, op)
			}
		}
	}
	fmt.Fprint(stdout, align.Format(shown))
	fmt.Fprintf(stderr, "distance: %d (del: %d, ins: %d)\n", dels+ins, dels, ins)
	return 0
}

func readItems(path string, stdin io.Reader) ([]string, error) {
	var r io.Reader
	if path == "-" {
		r = stdin
	} else {
		f, err := os.Open(path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = f
	}
	var items []string
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSuffix(sc.Text(), "\r")
		if line == "" {
			continue
		}
		items = append(items, line)
	}
	return items, sc.Err()
}
