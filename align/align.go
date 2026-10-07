// Package align computes minimal delete/insert edit scripts that transform an
// expected tool-input sequence into the actually scanned barcode sequence.
//
// Duplicates, missed scans and out-of-order scans are all handled: every
// barcode occurrence is a distinct positional slot, so identical barcodes are
// matched in order and never deduplicated.
package align

import (
	"fmt"
	"strings"
)

// OpKind identifies the kind of one edit operation.
type OpKind int

const (
	// Keep consumes the next expected item and emits it unchanged.
	Keep OpKind = iota
	// Del consumes the next expected item without emitting it (missed scan).
	Del
	// Ins emits an item without consuming an expected one (extra scan).
	Ins
)

// Op is a single step of an edit script.
type Op struct {
	Kind OpKind
	Item string
}

// token is the canonical one-line form of an operation. Tokens define the
// lexicographic order used to break ties between minimal scripts:
// "del ..." < "ins ..." < "keep ...".
func (op Op) token() string {
	var kind string
	switch op.Kind {
	case Keep:
		kind = "keep"
	case Del:
		kind = "del"
	case Ins:
		kind = "ins"
	}
	return kind + " " + op.Item
}

// script is an immutable linked list of operations so that DP states can
// share suffixes without copying.
type script struct {
	op   Op
	rest *script
}

func (s *script) toSlice() []Op {
	var ops []Op
	for cur := s; cur != nil; cur = cur.rest {
		ops = append(ops, cur.op)
	}
	return ops
}

// lessScripts reports whether a is lexicographically smaller than b,
// comparing operation tokens one by one; a proper prefix is smaller.
func lessScripts(a, b *script) bool {
	for a != nil && b != nil {
		ta, tb := a.op.token(), b.op.token()
		if ta != tb {
			return ta < tb
		}
		a, b = a.rest, b.rest
	}
	return b != nil
}

// Diff returns the minimal delete/insert edit script transforming expected
// into scanned. Among all minimal scripts the lexicographically smallest one
// (by operation token) is returned. Replaying the result over expected
// yields scanned (see Replay).
func Diff(expected, scanned []string) []Op {
	m, n := len(expected), len(scanned)
	type cell struct {
		cost int
		s    *script
	}
	dp := make([][]cell, m+1)
	for i := range dp {
		dp[i] = make([]cell, n+1)
	}
	for i := m; i >= 0; i-- {
		for j := n; j >= 0; j-- {
			if i == m && j == n {
				continue
			}
			best := cell{cost: -1}
			consider := func(c cell) {
				if best.cost < 0 || c.cost < best.cost ||
					(c.cost == best.cost && lessScripts(c.s, best.s)) {
					best = c
				}
			}
			if i < m && j < n && expected[i] == scanned[j] {
				sub := dp[i+1][j+1]
				consider(cell{sub.cost, &script{op: Op{Kind: Keep, Item: expected[i]}, rest: sub.s}})
			}
			if i < m {
				sub := dp[i+1][j]
				consider(cell{sub.cost + 1, &script{op: Op{Kind: Del, Item: expected[i]}, rest: sub.s}})
			}
			if j < n {
				sub := dp[i][j+1]
				consider(cell{sub.cost + 1, &script{op: Op{Kind: Ins, Item: scanned[j]}, rest: sub.s}})
			}
			dp[i][j] = best
		}
	}
	return dp[0][0].s.toSlice()
}

// Distance returns the number of delete/insert operations in the minimal
// script, i.e. the edit distance between the two sequences.
func Distance(expected, scanned []string) int {
	d := 0
	for _, op := range Diff(expected, scanned) {
		if op.Kind != Keep {
			d++
		}
	}
	return d
}

// Replay applies ops to expected and returns the resulting sequence. It
// fails if an operation does not match the expected item it consumes or if
// expected items are left unconsumed.
func Replay(expected []string, ops []Op) ([]string, error) {
	var out []string
	pos := 0
	for idx, op := range ops {
		switch op.Kind {
		case Keep, Del:
			if pos >= len(expected) {
				return nil, fmt.Errorf("op %d (%s): no expected item left", idx, op.token())
			}
			if expected[pos] != op.Item {
				return nil, fmt.Errorf("op %d (%s): expected item is %q", idx, op.token(), expected[pos])
			}
			if op.Kind == Keep {
				out = append(out, op.Item)
			}
			pos++
		case Ins:
			out = append(out, op.Item)
		default:
			return nil, fmt.Errorf("op %d: unknown kind %d", idx, op.Kind)
		}
	}
	if pos != len(expected) {
		return nil, fmt.Errorf("script left %d expected items unconsumed", len(expected)-pos)
	}
	return out, nil
}

// Format renders a script as replayable text, one operation per line.
func Format(ops []Op) string {
	var b strings.Builder
	for _, op := range ops {
		b.WriteString(op.token())
		b.WriteByte('\n')
	}
	return b.String()
}

// Parse reads a script produced by Format. Items must not contain newlines.
func Parse(text string) ([]Op, error) {
	var ops []Op
	for lineno, line := range strings.Split(text, "\n") {
		if line == "" {
			continue
		}
		kind, item, found := strings.Cut(line, " ")
		if !found {
			return nil, fmt.Errorf("line %d: malformed operation %q", lineno+1, line)
		}
		op := Op{Item: item}
		switch kind {
		case "keep":
			op.Kind = Keep
		case "del":
			op.Kind = Del
		case "ins":
			op.Kind = Ins
		default:
			return nil, fmt.Errorf("line %d: unknown operation %q", lineno+1, line)
		}
		ops = append(ops, op)
	}
	return ops, nil
}
