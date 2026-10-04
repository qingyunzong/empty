package main

import (
	"bufio"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// MaxOps is the maximum number of operations the checker accepts.
const MaxOps = 12

type OpKind int

const (
	Enq OpKind = iota
	Deq
)

// Op is a single queue operation observed by the CLI.
//
// Real-time model: an operation occupies the interval [Call, Ret].
// Operation i must precede j in any serial explanation iff i has
// returned before j was called, i.e. !i.Pending && i.Ret < j.Call.
type Op struct {
	ID       int    // 1-based position in the input
	Kind     OpKind // Enq or Deq
	Val      string // Enq: enqueued value. Deq: returned value (when !RetEmpty).
	RetEmpty bool   // Deq only: the operation returned "empty".
	Call     int64  // invocation time
	Ret      int64  // response time (meaningless when Pending)
	Pending  bool   // no response was observed; may be omitted or completed
}

func (o Op) String() string {
	ret := "-"
	if !o.Pending {
		ret = strconv.FormatInt(o.Ret, 10)
	}
	if o.Kind == Enq {
		return fmt.Sprintf("#%d enq(%s) call=%d ret=%s", o.ID, o.Val, o.Call, ret)
	}
	res := o.Val
	if o.RetEmpty {
		res = "empty"
	}
	if o.Pending {
		res = "?"
	}
	return fmt.Sprintf("#%d deq() -> %s call=%d ret=%s", o.ID, res, o.Call, ret)
}

// ParseHistory reads a history from r.
//
// Format, one operation per line (blank lines and '#' comments ignored):
//
//	enq <value> <call> <ret|->
//	deq <value|-> <call> <ret|->
//
// For deq, a value of '-' means the operation returned empty.
// A return time of '-' marks a pending (unreturned) operation; for a
// pending deq the value column is ignored and should be '-'.
func ParseHistory(r io.Reader) ([]Op, error) {
	var ops []Op
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
		if len(fields) != 4 {
			return nil, fmt.Errorf("line %d: want 4 fields (op value call ret), got %d", lineNo, len(fields))
		}
		if len(ops) >= MaxOps {
			return nil, fmt.Errorf("line %d: too many operations (max %d)", lineNo, MaxOps)
		}
		var op Op
		op.ID = len(ops) + 1
		switch fields[0] {
		case "enq":
			op.Kind = Enq
			if fields[1] == "-" {
				return nil, fmt.Errorf("line %d: enq requires a value", lineNo)
			}
			op.Val = fields[1]
		case "deq":
			op.Kind = Deq
			if fields[1] == "-" {
				op.RetEmpty = true
			} else {
				op.Val = fields[1]
			}
		default:
			return nil, fmt.Errorf("line %d: unknown op %q (want enq or deq)", lineNo, fields[0])
		}
		call, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad call time: %v", lineNo, err)
		}
		op.Call = call
		if fields[3] == "-" {
			op.Pending = true
			op.RetEmpty = false // value column of a pending deq is ignored
		} else {
			ret, err := strconv.ParseInt(fields[3], 10, 64)
			if err != nil {
				return nil, fmt.Errorf("line %d: bad return time: %v", lineNo, err)
			}
			if ret < call {
				return nil, fmt.Errorf("line %d: return time %d precedes call time %d", lineNo, ret, call)
			}
			op.Ret = ret
		}
		ops = append(ops, op)
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(ops) == 0 {
		return nil, fmt.Errorf("empty history")
	}
	return ops, nil
}

// Precedes reports whether op i must be serialized before op j under the
// real-time order: i returned strictly before j was called.
func Precedes(ops []Op, i, j int) bool {
	return !ops[i].Pending && ops[i].Ret < ops[j].Call
}

// Predecessors computes, for every op, the bitmask of ops that must be
// serialized before it.
func Predecessors(ops []Op) []int {
	preds := make([]int, len(ops))
	for j := range ops {
		for i := range ops {
			if i != j && Precedes(ops, i, j) {
				preds[j] |= 1 << i
			}
		}
	}
	return preds
}
