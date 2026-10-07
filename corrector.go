// Package corrector aligns a scanned barcode sequence with the expected
// item order using the minimum number of deletions and insertions.
//
// The model tolerates duplicate scans, missed scans and out-of-order scans.
// Barcodes are compared by value, but every entry keeps its own position:
// two identical barcodes are two distinct items and are never merged.
//
// Diff returns a replayable Script: applying it to the scanned sequence
// with Script.Apply yields the expected sequence. Among all minimum-cost
// scripts the lexicographically smallest one is chosen (see Compare).
package corrector

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// OpKind is the kind of a single edit operation.
type OpKind int

const (
	// Delete removes the item at Index from the evolving sequence.
	Delete OpKind = iota
	// Insert inserts Barcode into the evolving sequence at Index.
	Insert
)

func (k OpKind) String() string {
	switch k {
	case Delete:
		return "D"
	case Insert:
		return "I"
	default:
		return "?"
	}
}

// Op is a single edit operation. Index refers to the position in the
// sequence as it evolves while the script is applied in order, so a
// Script can be replayed streaming from left to right. For Delete,
// Barcode records the value that must be present at Index; Apply
// verifies it. Indexes within a Script produced by Diff are
// non-decreasing.
type Op struct {
	Kind    OpKind
	Index   int
	Barcode string
}

// Script is an ordered list of edit operations transforming the scanned
// sequence into the expected one.
type Script []Op

// compareOp orders ops by kind (Delete < Insert), then by index, then by
// barcode bytes.
func compareOp(a, b Op) int {
	if a.Kind != b.Kind {
		return int(a.Kind) - int(b.Kind)
	}
	if a.Index != b.Index {
		return a.Index - b.Index
	}
	return strings.Compare(a.Barcode, b.Barcode)
}

// Compare lexicographically compares two scripts op by op. A script that
// is a strict prefix of another is the smaller one.
func Compare(a, b Script) int {
	for i := 0; i < len(a) && i < len(b); i++ {
		if c := compareOp(a[i], b[i]); c != 0 {
			return c
		}
	}
	return len(a) - len(b)
}

// node is a persistent cons cell used to share script suffixes between
// dynamic-programming states without copying.
type node struct {
	op   Op
	next *node
}

// compareNodes lexicographically compares two cons-list scripts.
func compareNodes(a, b *node) int {
	for a != nil && b != nil {
		if c := compareOp(a.op, b.op); c != 0 {
			return c
		}
		a, b = a.next, b.next
	}
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return -1
	default:
		return 1
	}
}

// Distance returns the minimum number of deletions plus insertions needed
// to transform scanned into expected.
func Distance(expected, scanned []string) int {
	return len(Diff(expected, scanned))
}

// Diff computes the minimum number of delete/insert operations that turn
// the scanned sequence into the expected sequence and returns the
// lexicographically smallest script among all minimum-cost scripts.
//
// The result is replayable: Apply(Diff(expected, scanned), scanned)
// returns a copy of expected.
func Diff(expected, scanned []string) Script {
	n, m := len(scanned), len(expected)

	// cost[i][j] is the minimum number of ops transforming scanned[i:]
	// into expected[j:].
	cost := make([][]int, n+1)
	for i := range cost {
		cost[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		cost[i][m] = n - i
	}
	for j := m - 1; j >= 0; j-- {
		cost[n][j] = m - j
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if scanned[i] == expected[j] {
				cost[i][j] = cost[i+1][j+1]
			} else {
				cost[i][j] = 1 + min(cost[i+1][j], cost[i][j+1])
			}
		}
	}

	// best[i][j] is the lexicographically smallest minimum-cost script
	// suffix transforming scanned[i:] into expected[j:]. When the items
	// at the cursor are equal, matching them costs nothing, but deleting
	// or inserting can tie on cost and win lexicographically, so every
	// cost-optimal move is considered.
	best := make([][]*node, n+1)
	for i := range best {
		best[i] = make([]*node, m+1)
	}
	for i := n; i >= 0; i-- {
		for j := m; j >= 0; j-- {
			if i == n && j == m {
				continue
			}
			var pick *node
			consider := func(cand *node) {
				if pick == nil || compareNodes(cand, pick) < 0 {
					pick = cand
				}
			}
			if i < n && j < m && scanned[i] == expected[j] && cost[i][j] == cost[i+1][j+1] {
				consider(best[i+1][j+1])
			}
			if i < n && cost[i][j] == 1+cost[i+1][j] {
				consider(&node{op: Op{Kind: Delete, Index: j, Barcode: scanned[i]}, next: best[i+1][j]})
			}
			if j < m && cost[i][j] == 1+cost[i][j+1] {
				consider(&node{op: Op{Kind: Insert, Index: j, Barcode: expected[j]}, next: best[i][j+1]})
			}
			best[i][j] = pick
		}
	}

	var script Script
	for cur := best[0][0]; cur != nil; cur = cur.next {
		script = append(script, cur.op)
	}
	return script
}

// Apply replays the script on the scanned sequence and returns the
// resulting sequence. It reports an error if an index is out of range or
// a Delete finds a different barcode than the one recorded in the op.
func (s Script) Apply(scanned []string) ([]string, error) {
	seq := slices.Clone(scanned)
	for k, op := range s {
		switch op.Kind {
		case Delete:
			if op.Index < 0 || op.Index >= len(seq) {
				return nil, fmt.Errorf("op %d: delete index %d out of range (len %d)", k, op.Index, len(seq))
			}
			if seq[op.Index] != op.Barcode {
				return nil, fmt.Errorf("op %d: delete at %d: found %q, want %q", k, op.Index, seq[op.Index], op.Barcode)
			}
			seq = slices.Delete(seq, op.Index, op.Index+1)
		case Insert:
			if op.Index < 0 || op.Index > len(seq) {
				return nil, fmt.Errorf("op %d: insert index %d out of range (len %d)", k, op.Index, len(seq))
			}
			seq = slices.Insert(seq, op.Index, op.Barcode)
		default:
			return nil, fmt.Errorf("op %d: unknown kind %d", k, op.Kind)
		}
	}
	return seq, nil
}

// String renders the script in its canonical replayable text form, one
// op per line: "D <index> <quoted-barcode>" or "I <index>
// <quoted-barcode>". ParseScript inverts it.
func (s Script) String() string {
	var b strings.Builder
	for _, op := range s {
		fmt.Fprintf(&b, "%s %d %s\n", op.Kind, op.Index, strconv.Quote(op.Barcode))
	}
	return b.String()
}

// ParseScript parses the canonical text form produced by String.
func ParseScript(text string) (Script, error) {
	var script Script
	for lineno, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var kind OpKind
		rest := line
		kindField, rest, _ := strings.Cut(rest, " ")
		switch kindField {
		case "D":
			kind = Delete
		case "I":
			kind = Insert
		default:
			return nil, fmt.Errorf("line %d: unknown op %q", lineno+1, kindField)
		}
		indexField, rest, found := strings.Cut(strings.TrimLeft(rest, " "), " ")
		if !found {
			return nil, fmt.Errorf("line %d: want kind, index and quoted barcode", lineno+1)
		}
		index, err := strconv.Atoi(indexField)
		if err != nil {
			return nil, fmt.Errorf("line %d: bad index: %w", lineno+1, err)
		}
		barcode, err := strconv.Unquote(strings.TrimSpace(rest))
		if err != nil {
			return nil, fmt.Errorf("line %d: bad barcode: %w", lineno+1, err)
		}
		script = append(script, Op{Kind: kind, Index: index, Barcode: barcode})
	}
	return script, nil
}
