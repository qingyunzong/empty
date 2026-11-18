package formal

import (
	"fmt"
	"sort"
	"strings"
	"testing"
)

type historyOp struct {
	name  string
	apply func(*FS) error
}

func newHistoryBase(t *testing.T) *FS {
	t.Helper()
	fs := New()
	must(t, fs.MkdirAll("/a/sub"))
	must(t, fs.Mkdir("/b"))
	must(t, fs.Mkdir("/c"))
	must(t, fs.CreateFile("/a/f", 10))
	must(t, fs.CreateFile("/a/sub/g", 20))
	must(t, fs.CreateFile("/b/h", 30))
	// Two inodes cross directory branches through hard links.
	must(t, fs.Link("/a/f", "/c/f-link"))
	must(t, fs.Link("/b/h", "/a/sub/h-link"))
	return fs
}

// stateSignature canonicalizes inode identities by first encounter in a sorted
// traversal. Two histories therefore have the same signature exactly when they
// describe the same namespace tree, including which entries share an inode.
func stateSignature(fs *FS) string {
	var b strings.Builder
	ids := make(map[*inode]int)
	next := 0

	var walk func(*directory)
	walk = func(dir *directory) {
		names := make([]string, 0, len(dir.entries))
		for name := range dir.entries {
			names = append(names, name)
		}
		sort.Strings(names)
		b.WriteByte('{')
		for _, name := range names {
			in := dir.entries[name]
			id, ok := ids[in]
			if !ok {
				id = next
				next++
				ids[in] = id
			}
			fmt.Fprintf(&b, "%q:%d:%d:%d;", name, id, in.kind, in.size)
			if in.kind == kindDir {
				walk(in.dir)
			}
		}
		b.WriteByte('}')
	}
	walk(fs.root)
	return b.String()
}

func replayHistory(t *testing.T, ops []historyOp, history []int) *FS {
	t.Helper()
	fs := newHistoryBase(t)
	for step, idx := range history {
		if err := ops[idx].apply(fs); err != nil {
			t.Fatalf("replaying op %d (%s) at step %d: %v", idx, ops[idx].name, step, err)
		}
	}
	return fs
}

func verifyAllDirectories(t *testing.T, fs *FS, context string) {
	t.Helper()
	for _, dir := range fs.Dirs() {
		maintained, err := fs.Stats(dir.Path)
		if err != nil {
			t.Fatalf("%s: Stats(%q): %v", context, dir.Path, err)
		}
		naive, err := fs.NaiveStats(dir.Path)
		if err != nil {
			t.Fatalf("%s: NaiveStats(%q): %v", context, dir.Path, err)
		}
		if maintained != naive {
			t.Fatalf("%s: %s maintained %s, naive %s", context, dir.Path, maintained, naive)
		}
	}
}

// TestExhaustiveOperationHistories explores every distinct namespace state
// reachable from a small filesystem by the operations below. Every transition
// is audited, and every newly discovered directory is compared against a naive
// per-entry walk. Because state behavior depends only on the state, visiting
// each state once covers all operation histories up to arbitrary length.
func TestExhaustiveOperationHistories(t *testing.T) {
	ops := []historyOp{
		{"rename f to b", func(fs *FS) error { return fs.Rename("/a/f", "/b/f") }},
		{"rename f back", func(fs *FS) error { return fs.Rename("/b/f", "/a/f") }},
		{"rename sub to b", func(fs *FS) error { return fs.Rename("/a/sub", "/b/sub") }},
		{"rename sub back", func(fs *FS) error { return fs.Rename("/b/sub", "/a/sub") }},
		{"rename a under c", func(fs *FS) error { return fs.Rename("/a", "/c/a") }},
		{"rename a back", func(fs *FS) error { return fs.Rename("/c/a", "/a") }},
		{"move c under a/sub", func(fs *FS) error { return fs.Rename("/c", "/a/sub/c") }},
		{"move c back", func(fs *FS) error { return fs.Rename("/a/sub/c", "/c") }},
		{"link f in c", func(fs *FS) error { return fs.Link("/a/f", "/c/f2") }},
		{"remove f link in c", func(fs *FS) error { return fs.Remove("/c/f2") }},
		{"link h in a", func(fs *FS) error { return fs.Link("/b/h", "/a/h2") }},
		{"remove h link in a", func(fs *FS) error { return fs.Remove("/a/h2") }},
		{"rename g to c", func(fs *FS) error { return fs.Rename("/a/sub/g", "/c/g") }},
		{"rename g back", func(fs *FS) error { return fs.Rename("/c/g", "/a/sub/g") }},
		{"remove h", func(fs *FS) error { return fs.Remove("/b/h") }},
		{"remove all a/sub", func(fs *FS) error { return fs.RemoveAll("/a/sub") }},
		{"remove all b", func(fs *FS) error { return fs.RemoveAll("/b") }},
		{"mkdir b", func(fs *FS) error { return fs.Mkdir("/b") }},
		{"mkdir b/new", func(fs *FS) error { return fs.Mkdir("/b/new") }},
		{"remove b/new", func(fs *FS) error { return fs.Remove("/b/new") }},
		{"remove all c", func(fs *FS) error { return fs.RemoveAll("/c") }},
		{"mkdir c", func(fs *FS) error { return fs.Mkdir("/c") }},
	}

	type node struct {
		history []int
	}

	start := replayHistory(t, ops, nil)
	startSig := stateSignature(start)
	if err := start.Check(); err != nil {
		t.Fatalf("initial Check: %v", err)
	}
	verifyAllDirectories(t, start, "initial")

	seen := map[string]bool{startSig: true}
	queue := []node{{}}
	successes := make([]int, len(ops))
	states := 0
	transitions := 0
	const maxStates = 50000

	for len(queue) != 0 {
		cur := queue[0]
		queue = queue[1:]
		parent := replayHistory(t, ops, cur.history)
		if err := parent.Check(); err != nil {
			t.Fatalf("history %v: Check: %v", cur.history, err)
		}

		for idx, op := range ops {
			child := replayHistory(t, ops, cur.history)
			if err := op.apply(child); err != nil {
				continue
			}
			successes[idx]++
			transitions++

			if err := child.Check(); err != nil {
				t.Fatalf("history %v + %s: Check: %v", cur.history, op.name, err)
			}

			sig := stateSignature(child)
			if seen[sig] {
				continue
			}
			seen[sig] = true
			states++
			if states > maxStates {
				t.Fatalf("state space exceeded %d states", maxStates)
			}

			nextHistory := make([]int, len(cur.history)+1)
			copy(nextHistory, cur.history)
			nextHistory[len(cur.history)] = idx
			verifyAllDirectories(t, child, fmt.Sprintf("history %v", nextHistory))
			queue = append(queue, node{history: nextHistory})
		}
	}

	for idx, op := range ops {
		if successes[idx] == 0 {
			t.Errorf("operation %q never applied; test does not cover it", op.name)
		}
	}
	if states < 1000 {
		t.Fatalf("only %d distinct states explored; expected a broad history space", states)
	}
	t.Logf("explored %d states and audited %d successful transitions", states, transitions)
}
