// Command queuediag diagnoses an observed queue history read from a file
// (or stdin) and searches for a serial explanation consistent with the
// real-time order. Overlapping operations may be reordered arbitrarily;
// operations without a recorded response may be omitted or completed.
//
// Input format (one operation per line, '#' starts a comment):
//
//	enq <value> <call> [ret]        enqueue; pending if ret omitted
//	deq <value|empty> <call> <ret>  completed dequeue with its result
//	deq ? <call>                    pending dequeue
//
// At most 12 operations are accepted.
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"queuediag/checker"
)

const maxOps = 12

func parse(r io.Reader) ([]checker.Op, error) {
	var ops []checker.Op
	sc := bufio.NewScanner(r)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := sc.Text()
		if i := strings.IndexByte(line, '#'); i >= 0 {
			line = line[:i]
		}
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		if len(ops) >= maxOps {
			return nil, fmt.Errorf("line %d: more than %d operations", lineNo, maxOps)
		}
		op := checker.Op{ID: len(ops) + 1}
		bad := func() error {
			return fmt.Errorf("line %d: malformed operation %q", lineNo, strings.Join(fields, " "))
		}
		switch fields[0] {
		case "enq":
			if len(fields) != 3 && len(fields) != 4 {
				return nil, bad()
			}
			op.Kind = checker.Enqueue
			v, err := strconv.Atoi(fields[1])
			if err != nil {
				return nil, bad()
			}
			op.Val = v
			c, err := strconv.ParseInt(fields[2], 10, 64)
			if err != nil {
				return nil, bad()
			}
			op.Call = c
			if len(fields) == 4 {
				rt, err := strconv.ParseInt(fields[3], 10, 64)
				if err != nil {
					return nil, bad()
				}
				op.Ret = rt
			} else {
				op.Pending = true
			}
		case "deq":
			if len(fields) != 3 && len(fields) != 4 {
				return nil, bad()
			}
			op.Kind = checker.Dequeue
			c, err := strconv.ParseInt(fields[2], 10, 64)
			if err != nil {
				return nil, bad()
			}
			op.Call = c
			switch fields[1] {
			case "?":
				if len(fields) != 3 {
					return nil, bad()
				}
				op.Pending = true
			case "empty":
				if len(fields) != 4 {
					return nil, bad()
				}
				op.Empty = true
				rt, err := strconv.ParseInt(fields[3], 10, 64)
				if err != nil {
					return nil, bad()
				}
				op.Ret = rt
			default:
				if len(fields) != 4 {
					return nil, bad()
				}
				v, err := strconv.Atoi(fields[1])
				if err != nil {
					return nil, bad()
				}
				op.Val = v
				rt, err := strconv.ParseInt(fields[3], 10, 64)
				if err != nil {
					return nil, bad()
				}
				op.Ret = rt
			}
		default:
			return nil, bad()
		}
		if !op.Pending && op.Ret < op.Call {
			return nil, fmt.Errorf("line %d: response time %d precedes call time %d", lineNo, op.Ret, op.Call)
		}
		ops = append(ops, op)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(ops) == 0 {
		return nil, fmt.Errorf("no operations given")
	}
	return ops, nil
}

func main() {
	var r io.Reader = os.Stdin
	if len(os.Args) > 2 {
		fmt.Fprintln(os.Stderr, "usage: queuediag [history-file]")
		os.Exit(2)
	}
	if len(os.Args) == 2 {
		f, err := os.Open(os.Args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, "queuediag:", err)
			os.Exit(2)
		}
		defer f.Close()
		r = f
	}
	ops, err := parse(r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "queuediag:", err)
		os.Exit(2)
	}

	fmt.Printf("history: %d operation(s)\n", len(ops))
	for _, o := range ops {
		fmt.Println("  ", o)
	}

	witness, ok := checker.Solve(ops)
	bfWitness, bfOK := checker.BruteForce(ops)
	switch {
	case ok != bfOK:
		fmt.Printf("INTERNAL ERROR: solver=%v but brute-force=%v\n", ok, bfOK)
		os.Exit(1)
	case !ok:
		fmt.Println("INFEASIBLE: no serial explanation exists")
		fmt.Println("  confirmed by exhaustive subset x permutation enumeration")
		return
	}
	if err := checker.Validate(witness); err != nil {
		fmt.Println("INTERNAL ERROR: invalid witness:", err)
		os.Exit(1)
	}
	if err := checker.Validate(bfWitness); err != nil {
		fmt.Println("INTERNAL ERROR: invalid brute-force witness:", err)
		os.Exit(1)
	}
	fmt.Println("FEASIBLE: serial explanation found (brute-force enumeration agrees)")
	fmt.Println("witness order:")
	queue := []int{}
	for i, o := range witness {
		queue, _ = checker.Step(queue, o)
		fmt.Printf("  %2d. %-40s queue=%v\n", i+1, o, queue)
	}
	omitted := omittedOps(ops, witness)
	if len(omitted) > 0 {
		fmt.Println("omitted pending operations:")
		for _, o := range omitted {
			fmt.Println("  ", o)
		}
	}
}

func omittedOps(ops, witness []checker.Op) []checker.Op {
	in := map[int]bool{}
	for _, o := range witness {
		in[o.ID] = true
	}
	var out []checker.Op
	for _, o := range ops {
		if !in[o.ID] {
			out = append(out, o)
		}
	}
	return out
}
