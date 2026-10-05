// Command match finds the leftmost-longest match of a pattern in each
// input string and prints the match span and capture groups.
//
// Usage:
//
//	match PATTERN [STRING ...]
//
// If no STRING arguments are given, lines are read from standard input.
// Offsets are reported as rune indices [start:end). Exit status is 0 if
// at least one input matched, 1 if none did, and 2 on error.
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"

	"searchre"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}

func run(args []string, stdin io.Reader, stdout io.Writer) int {
	if len(args) < 1 {
		fmt.Fprintln(stdout, "usage: match PATTERN [STRING ...]")
		return 2
	}
	re, err := searchre.Compile(args[0])
	if err != nil {
		fmt.Fprintf(stdout, "match: bad pattern: %v\n", err)
		return 2
	}
	matched := false
	if len(args) > 1 {
		for _, s := range args[1:] {
			if report(re, s, len(args) > 2, stdout) {
				matched = true
			}
		}
	} else {
		sc := bufio.NewScanner(stdin)
		for sc.Scan() {
			if report(re, sc.Text(), true, stdout) {
				matched = true
			}
		}
		if err := sc.Err(); err != nil {
			fmt.Fprintf(stdout, "match: reading input: %v\n", err)
			return 2
		}
	}
	if !matched {
		return 1
	}
	return 0
}

// report prints the match result for one input and reports whether it matched.
func report(re *searchre.Regexp, s string, prefix bool, w io.Writer) bool {
	caps := re.FindSubmatchIndex(s)
	if caps == nil {
		if prefix {
			fmt.Fprintf(w, "%q: no match\n", s)
		} else {
			fmt.Fprintln(w, "no match")
		}
		return false
	}
	r := []rune(s)
	head := fmt.Sprintf("match [%d:%d] %q", caps[0], caps[1], string(r[caps[0]:caps[1]]))
	if prefix {
		head = fmt.Sprintf("%q: ", s) + head
	}
	fmt.Fprintln(w, head)
	for g := 1; g <= re.NumGroups(); g++ {
		lo, hi := caps[2*g], caps[2*g+1]
		if lo < 0 {
			fmt.Fprintf(w, "  $%d: <unset>\n", g)
		} else {
			fmt.Fprintf(w, "  $%d [%d:%d] %q\n", g, lo, hi, string(r[lo:hi]))
		}
	}
	return true
}
