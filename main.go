package main

import (
	"fmt"
	"os"
	"strings"
)

// run executes the CLI: parse, minimize, independently verify, report.
// It returns the process exit code.
func run(args []string, stdin *os.File, stdout, stderr *os.File) int {
	in, err := ParseInput(stdin)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 2
	}
	subset, ok := MinSubset(in.Rules, in.Value)
	if !ok {
		fmt.Fprintln(stdout, "NONE")
		fmt.Fprintln(stderr, "request is not denied by any subset of the rules")
		return 0
	}
	if err := VerifyMinimal(in.Rules, in.Value, subset); err != nil {
		fmt.Fprintf(stderr, "internal error: minimality verification failed: %v\n", err)
		return 1
	}
	fmt.Fprintln(stdout, len(subset))
	fmt.Fprintln(stdout, strings.Join(ruleIDs(subset), " "))
	fmt.Fprintf(stderr, "verified: no smaller subset denies, and none of equal size precedes it in ID order\n")
	return 0
}

func main() {
	os.Exit(run(os.Args, os.Stdin, os.Stdout, os.Stderr))
}
