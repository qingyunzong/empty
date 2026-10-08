// Command bchandler validates half-open protected bytecode intervals and
// prints the effective handler chain for every instruction.
//
// Usage:
//
//	bchandler [-insert at:count]... spec.json
//
// The spec is a JSON document:
//
//	{
//	  "code": ["iconst_0", "iconst_1", "iadd"],   // or "length": 3
//	  "handlers": [{"name": "h0", "start": 0, "end": 3, "type": "java/lang/Exception"}],
//	  "insert": [{"at": 1, "count": 2}]
//	}
//
// Handler intervals are half-open [start, end). Crossing (partially
// overlapping) intervals are rejected. The chain at each instruction lists
// covering handlers innermost first; identical intervals are ordered by
// declaration index. Insertions remap interval endpoints and the report
// shows the remapped table and chains.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"bchandler"
)

type insertFlags []bchandler.InsertSpec

func (f *insertFlags) String() string {
	parts := make([]string, len(*f))
	for i, ins := range *f {
		parts[i] = fmt.Sprintf("%d:%d", ins.At, ins.Count)
	}
	return strings.Join(parts, ",")
}

func (f *insertFlags) Set(value string) error {
	at, count, ok := strings.Cut(value, ":")
	if !ok {
		return fmt.Errorf("insert %q: want at:count", value)
	}
	a, err := strconv.Atoi(at)
	if err != nil {
		return fmt.Errorf("insert %q: %v", value, err)
	}
	c, err := strconv.Atoi(count)
	if err != nil {
		return fmt.Errorf("insert %q: %v", value, err)
	}
	*f = append(*f, bchandler.InsertSpec{At: a, Count: c})
	return nil
}

func run(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("bchandler", flag.ContinueOnError)
	fs.SetOutput(out)
	var inserts insertFlags
	fs.Var(&inserts, "insert", "insert count instructions before index at, as at:count (repeatable)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 1 {
		fs.Usage()
		return fmt.Errorf("want exactly one spec file")
	}
	spec, err := bchandler.LoadSpec(fs.Arg(0))
	if err != nil {
		return err
	}
	return bchandler.Report(spec, inserts, out)
}

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "bchandler:", err)
		os.Exit(1)
	}
}
