// Package logrules implements a logging rule engine with generation-scoped
// dynamic rule replacement, single-match semantics per record, an explicit
// derivation depth budget, and provenance trees for every emitted record.
package logrules

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Record is a single log record or derived diagnostic.
type Record struct {
	ID        int64  // unique id within an Engine run
	Seq       uint64 // sequence number of the root record this tree belongs to
	Gen       uint64 // rule generation used to match this record
	Depth     int    // derivation depth; root records have depth 0
	Message   string
	RuleID    string // id of the rule that derived this record; "" for roots
	ParentID  int64  // id of the deriving record; -1 for roots
	Truncated bool   // true if derivation was cut off by the depth budget
}

// Rule matches a record and may derive diagnostic messages from it.
type Rule struct {
	ID     string
	Match  func(Record) bool
	Derive func(Record) []string
}

// Engine assigns sequence numbers, snapshots rule generations, and processes
// records. The zero value is not ready for use; construct with NewEngine.
type Engine struct {
	mu       sync.Mutex
	gen      uint64
	rules    []Rule
	seq      uint64
	nextID   int64
	maxDepth int
}

// NewEngine creates an Engine with the given initial rules and derivation
// depth budget. maxDepth is the maximum Depth a record may reach; records at
// that depth are never matched again.
func NewEngine(rules []Rule, maxDepth int) *Engine {
	if maxDepth < 0 {
		maxDepth = 0
	}
	e := &Engine{maxDepth: maxDepth, nextID: 1}
	e.rules = append([]Rule(nil), rules...)
	return e
}

// SetRules atomically replaces the rule set. The replacement takes effect
// starting with the next sequence number assigned by Log; records already
// assigned a sequence number keep their original generation.
func (e *Engine) SetRules(rules []Rule) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.gen++
	e.rules = append([]Rule(nil), rules...)
}

// Log assigns the next sequence number, pins the current rule generation to
// the record, and processes it. The returned slice is the full provenance
// forest of the record: the root followed by every derived diagnostic.
func (e *Engine) Log(message string) []Record {
	e.mu.Lock()
	e.seq++
	root := Record{
		ID:       e.nextID,
		Seq:      e.seq,
		Gen:      e.gen,
		Message:  message,
		ParentID: -1,
	}
	e.nextID++
	rules := append([]Rule(nil), e.rules...)
	e.mu.Unlock()

	ids := &idAllocator{next: &e.nextID, mu: &e.mu}
	return deriveAll(root, rules, e.maxDepth, ids)
}

// idAllocator hands out record ids from the engine's shared counter so ids
// stay unique across concurrent Log calls.
type idAllocator struct {
	mu   *sync.Mutex
	next *int64
}

func (a *idAllocator) alloc() int64 {
	a.mu.Lock()
	defer a.mu.Unlock()
	id := *a.next
	*a.next++
	return id
}

// deriveChild builds the child record produced by rule r from parent.
func deriveChild(parent Record, r Rule, message string, alloc func() int64) Record {
	return Record{
		ID:       alloc(),
		Seq:      parent.Seq,
		Gen:      parent.Gen,
		Depth:    parent.Depth + 1,
		Message:  message,
		RuleID:   r.ID,
		ParentID: parent.ID,
	}
}

// wouldDerive reports whether any rule matches rec and yields diagnostics.
func wouldDerive(rec Record, rules []Rule) bool {
	for _, r := range rules {
		if r.Match(rec) && len(r.Derive(rec)) > 0 {
			return true
		}
	}
	return false
}

// deriveAll is the production interpreter: an iterative breadth-first
// worklist. Every record is matched exactly once; derived diagnostics are new
// records and never cause their parent (or the root) to be matched again.
// All matching uses the single rule generation pinned to the root record.
func deriveAll(root Record, rules []Rule, maxDepth int, alloc interface{ alloc() int64 }) []Record {
	out := []Record{root}
	if root.Depth >= maxDepth {
		if wouldDerive(root, rules) {
			out[0].Truncated = true
		}
		return out
	}
	queue := []Record{root}
	for len(queue) > 0 {
		rec := queue[0]
		queue = queue[1:]
		for _, r := range rules {
			if !r.Match(rec) {
				continue
			}
			for _, msg := range r.Derive(rec) {
				child := deriveChild(rec, r, msg, alloc.alloc)
				out = append(out, child)
				if child.Depth >= maxDepth {
					if wouldDerive(child, rules) {
						out[len(out)-1].Truncated = true
					}
					continue
				}
				queue = append(queue, child)
			}
		}
	}
	return out
}

// FormatTree renders the provenance tree of a record forest. The root is the
// record with ParentID == -1; children are ordered by id.
func FormatTree(recs []Record) string {
	children := map[int64][]Record{}
	var root Record
	found := false
	for _, r := range recs {
		if r.ParentID == -1 {
			root = r
			found = true
			continue
		}
		children[r.ParentID] = append(children[r.ParentID], r)
	}
	if !found {
		return "(empty)\n"
	}
	for _, c := range children {
		sort.Slice(c, func(i, j int) bool { return c[i].ID < c[j].ID })
	}
	var b strings.Builder
	walkChild(root, children, "", &b)
	return b.String()
}

func walkChild(r Record, children map[int64][]Record, prefix string, b *strings.Builder) {
	trunc := ""
	if r.Truncated {
		trunc = " [TRUNCATED: depth budget exhausted]"
	}
	rule := r.RuleID
	if rule == "" {
		rule = "(root)"
	}
	fmt.Fprintf(b, "#%d seq=%d gen=%d depth=%d rule=%s msg=%q%s\n",
		r.ID, r.Seq, r.Gen, r.Depth, rule, r.Message, trunc)
	kids := children[r.ID]
	for i, k := range kids {
		last := i == len(kids)-1
		if last {
			b.WriteString(prefix + "└─ ")
			walkChild(k, children, prefix+"   ", b)
		} else {
			b.WriteString(prefix + "├─ ")
			walkChild(k, children, prefix+"│  ", b)
		}
	}
}
