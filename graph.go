package txnlib

import (
	"fmt"
	"sort"
	"strings"
)

// EdgeKind classifies a serialization-graph dependency.
type EdgeKind int

const (
	// EdgeWR is a read-from edge: the destination read a value the source wrote.
	EdgeWR EdgeKind = iota
	// EdgeWW is a write-write edge: both transactions wrote the same key.
	EdgeWW
	// EdgeRW is an anti-dependency: the source read a key (or a range
	// covering it) that the destination wrote later. A later insert into
	// a scanned range is a phantom and also forms an EdgeRW edge.
	EdgeRW
)

func (k EdgeKind) String() string {
	switch k {
	case EdgeWR:
		return "wr"
	case EdgeWW:
		return "ww"
	default:
		return "rw"
	}
}

// Edge is one dependency between two transactions, with the key that
// caused it. Phantom marks anti-dependencies caused by a key the reader
// did not observe (e.g. an insert into a scanned range).
type Edge struct {
	From, To TxnID
	Kind     EdgeKind
	Key      string
	Phantom  bool
}

func (e Edge) String() string {
	label := e.Kind.String()
	if e.Phantom {
		label += "/phantom"
	}
	return fmt.Sprintf("T%d -%s(%s)-> T%d", e.From, label, e.Key, e.To)
}

// CommitError reports an aborted commit and carries the cycle evidence.
type CommitError struct {
	Victim TxnID   // aborted transaction (newest commit requester)
	Cycle  []TxnID // transactions on the cycle, in edge order
	Edges  []Edge  // cycle edges; Edges[i] goes Cycle[i] -> Cycle[i+1]
}

func (e *CommitError) Error() string {
	return fmt.Sprintf("txnlib: commit aborted T%d: anti-dependency cycle %s",
		e.Victim, e.Evidence())
}

// Evidence renders the cycle as a chain of labeled edges.
func (e *CommitError) Evidence() string {
	parts := make([]string, len(e.Edges))
	for i, ed := range e.Edges {
		parts[i] = ed.String()
	}
	return strings.Join(parts, "  ")
}

type writeRef struct {
	txn *Txn
	op  WriteOp
}

// buildEdges derives wr/ww/rw dependency edges (phantoms included) from
// the recorded operations of the given transactions.
func buildEdges(txns []*Txn) []Edge {
	writesByKey := make(map[string][]writeRef)
	for _, t := range txns {
		for _, w := range t.Writes {
			writesByKey[w.Key] = append(writesByKey[w.Key], writeRef{t, w})
		}
	}
	for _, ws := range writesByKey {
		sort.Slice(ws, func(i, j int) bool { return ws[i].op.Seq < ws[j].op.Seq })
	}

	type edgeKey struct {
		from, to TxnID
		kind     EdgeKind
		key      string
	}
	seen := make(map[edgeKey]bool)
	var edges []Edge
	add := func(e Edge) {
		if e.From == e.To {
			return
		}
		k := edgeKey{e.From, e.To, e.Kind, e.Key}
		if seen[k] {
			return
		}
		seen[k] = true
		edges = append(edges, e)
	}

	for _, t := range txns {
		for _, r := range t.Reads {
			// wr: latest committed writer of each observed key before the read.
			for key := range r.Values {
				latest := -1
				ws := writesByKey[key]
				for i := range ws {
					if ws[i].op.Seq < r.Seq {
						latest = i
					}
				}
				if latest >= 0 && ws[latest].txn != t {
					add(Edge{From: ws[latest].txn.ID, To: t.ID, Kind: EdgeWR, Key: key})
				}
			}
			// rw: any later write whose key the read predicate covers.
			// A key the reader never observed is a phantom.
			for key, ws := range writesByKey {
				if !r.Pred.Covers(key) {
					continue
				}
				for _, w := range ws {
					if w.txn == t || w.op.Seq <= r.Seq {
						continue
					}
					_, observed := r.Values[key]
					add(Edge{From: t.ID, To: w.txn.ID, Kind: EdgeRW, Key: key, Phantom: !observed})
				}
			}
		}
	}
	// ww: consecutive writers of the same key.
	for key, ws := range writesByKey {
		for i := 0; i+1 < len(ws); i++ {
			add(Edge{From: ws[i].txn.ID, To: ws[i+1].txn.ID, Kind: EdgeWW, Key: key})
		}
	}

	sort.Slice(edges, func(i, j int) bool {
		a, b := edges[i], edges[j]
		if a.From != b.From {
			return a.From < b.From
		}
		if a.To != b.To {
			return a.To < b.To
		}
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		return a.Key < b.Key
	})
	return edges
}

// findCycle returns one cycle (nodes in edge order, plus the cycle edges)
// or nil if the graph is acyclic. Deterministic: nodes and edges are
// visited in sorted order.
func findCycle(txns []*Txn, edges []Edge) ([]TxnID, []Edge) {
	adj := make(map[TxnID][]Edge)
	for _, e := range edges {
		adj[e.From] = append(adj[e.From], e)
	}
	ids := make([]int, 0, len(txns))
	for _, t := range txns {
		ids = append(ids, int(t.ID))
	}
	sort.Ints(ids)

	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[TxnID]int)
	var stack []TxnID
	var stackEdges []Edge // stackEdges[i] leads into stack[i+1]
	var cycle []TxnID
	var cycEdges []Edge

	var dfs func(u TxnID) bool
	dfs = func(u TxnID) bool {
		color[u] = gray
		stack = append(stack, u)
		for _, e := range adj[u] {
			switch color[e.To] {
			case gray:
				idx := 0
				for stack[idx] != e.To {
					idx++
				}
				cycle = append([]TxnID{}, stack[idx:]...)
				cycEdges = append([]Edge{}, stackEdges[idx:]...)
				cycEdges = append(cycEdges, e)
				return true
			case white:
				stackEdges = append(stackEdges, e)
				if dfs(e.To) {
					return true
				}
				stackEdges = stackEdges[:len(stackEdges)-1]
			}
		}
		stack = stack[:len(stack)-1]
		color[u] = black
		return false
	}
	for _, id := range ids {
		if color[TxnID(id)] == white && dfs(TxnID(id)) {
			return cycle, cycEdges
		}
	}
	return nil, nil
}
