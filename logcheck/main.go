// Command logcheck verifies that the delivery logs of three nodes are
// prefix-consistent: for every pair of nodes, one log must be a prefix of
// the other. A crashed node may legitimately hold a shorter prefix; an
// unknown status is never treated as a fault. On divergence it reports the
// earliest conflicting index and the two sources involved.
//
// Usage:
//
//	logcheck check [-incr] [-verify] <file>
//	logcheck append <file> <node> <value>
//
// Log file format (one directive per line):
//
//	status <node> <ok|crashed|unknown>
//	entry  <node> <value>
//
// Exit codes: 0 consistent, 1 conflict found, 2 usage/parse error,
// 3 incremental model disagrees with the full-comparison model.
package main

import (
	"flag"
	"fmt"
	"os"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) < 1 {
		usage()
		return 2
	}
	switch args[0] {
	case "check":
		return cmdCheck(args[1:])
	case "append":
		return cmdAppend(args[1:])
	default:
		usage()
		return 2
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  logcheck check [-incr] [-verify] <file>   check prefix consistency
  logcheck append <file> <node> <value>     append an entry, then verify

log file directives:
  status <node> <ok|crashed|unknown>
  entry  <node> <value>`)
}

func cmdCheck(args []string) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	incr := fs.Bool("incr", false, "use the incremental append model")
	verify := fs.Bool("verify", false, "cross-check incremental model against the full-comparison model")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		usage()
		return 2
	}
	f, err := os.Open(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(os.Stderr, "logcheck:", err)
		return 2
	}
	defer f.Close()

	if *verify {
		return verifyModels(f)
	}

	if *incr {
		ic := NewIncrChecker()
		if err := ParseLog(f, ic); err != nil {
			fmt.Fprintln(os.Stderr, "logcheck:", err)
			return 2
		}
		c, found := ic.Result()
		fmt.Print(Report(ic.LogSet(), c, found))
		if found {
			return 1
		}
		return 0
	}

	set := NewLogSet()
	if err := ParseLog(f, set); err != nil {
		fmt.Fprintln(os.Stderr, "logcheck:", err)
		return 2
	}
	c, found := FullCheck(set)
	fmt.Print(Report(set, c, found))
	if found {
		return 1
	}
	return 0
}

// verifyModels feeds the log through both the incremental and the full
// model and requires identical verdicts.
func verifyModels(f *os.File) int {
	ic := NewIncrChecker()
	if err := ParseLog(f, ic); err != nil {
		fmt.Fprintln(os.Stderr, "logcheck:", err)
		return 2
	}
	incrC, incrFound := ic.Result()
	fullC, fullFound := FullCheck(ic.LogSet())
	if incrFound != fullFound || (incrFound && incrC != fullC) {
		fmt.Fprintf(os.Stderr, "logcheck: MODEL MISMATCH: incremental=%v full=%v\n", incrC, fullC)
		return 3
	}
	fmt.Print(Report(ic.LogSet(), fullC, fullFound))
	fmt.Println("models agree: incremental == full")
	if fullFound {
		return 1
	}
	return 0
}

func cmdAppend(args []string) int {
	if len(args) != 3 {
		usage()
		return 2
	}
	path, node, value := args[0], args[1], args[2]
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		fmt.Fprintln(os.Stderr, "logcheck:", err)
		return 2
	}
	if _, err := fmt.Fprintf(f, "entry %s %s\n", node, value); err != nil {
		f.Close()
		fmt.Fprintln(os.Stderr, "logcheck:", err)
		return 2
	}
	f.Close()

	rf, err := os.Open(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "logcheck:", err)
		return 2
	}
	defer rf.Close()
	return verifyModels(rf)
}
