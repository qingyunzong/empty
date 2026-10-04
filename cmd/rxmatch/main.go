// Command rxmatch matches a pattern against a string and prints the
// leftmost-longest match together with its capture groups.
//
// Usage:
//
//	rxmatch <pattern> <string>
//
// The pattern supports literals, (groups), a|b alternation, and the *
// and ? postfix operators. \ escapes a metacharacter. Exit status is 0
// when the pattern matches, 1 when it does not, and 2 on usage or
// pattern errors.
package main

import (
	"fmt"
	"os"

	"rxmatch/regex"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintf(os.Stderr, "usage: %s <pattern> <string>\n", os.Args[0])
		os.Exit(2)
	}
	pattern, s := os.Args[1], os.Args[2]
	re, err := regex.Compile(pattern)
	if err != nil {
		fmt.Fprintf(os.Stderr, "rxmatch: invalid pattern: %v\n", err)
		os.Exit(2)
	}
	caps, ok := re.Find(s)
	if !ok {
		fmt.Println("no match")
		os.Exit(1)
	}
	fmt.Printf("match: [%d,%d) %q\n", caps[0], caps[1], s[caps[0]:caps[1]])
	for g := 1; g < re.NumGroups(); g++ {
		lo, hi := caps[2*g], caps[2*g+1]
		if lo < 0 {
			fmt.Printf("$%d: <unset>\n", g)
		} else {
			fmt.Printf("$%d: [%d,%d) %q\n", g, lo, hi, s[lo:hi])
		}
	}
}
