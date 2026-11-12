// Package dataeng maintains grouped, versioned top-K leaderboards for a
// streaming analytics host. Records are identified by a unique ID, carry a
// group name and an int64 score, and are mutated in atomic batches.
package dataeng

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

// OpKind identifies the kind of a single batch operation.
type OpKind int

const (
	// OpUpsert inserts a record or replaces the record with the same ID,
	// possibly moving it to another group.
	OpUpsert OpKind = iota
	// OpDelete removes the record with the given ID. Deleting an ID that
	// does not exist aborts the whole batch with ErrNotFound.
	OpDelete
)

// Op is a single operation inside a batch.
type Op struct {
	Kind  OpKind
	ID    string
	Group string // upsert only
	Score int64  // upsert only
}

// Upsert returns an Op that inserts or replaces a record.
func Upsert(id, group string, score int64) Op {
	return Op{Kind: OpUpsert, ID: id, Group: group, Score: score}
}

// Delete returns an Op that removes a record by ID.
func Delete(id string) Op {
	return Op{Kind: OpDelete, ID: id}
}

// Entry is one row of a group leaderboard. Rank is 1-based.
type Entry struct {
	Rank  int
	ID    string
	Score int64
}

// ChangeKind describes how one board entry changed between two commits.
type ChangeKind int

const (
	// ChangeRemoved marks an entry that was on the old board but is not on
	// the new board.
	ChangeRemoved ChangeKind = iota
	// ChangeAdded marks an entry that is on the new board but was not on
	// the old board.
	ChangeAdded
	// ChangeUpdated marks an entry present on both boards whose rank
	// and/or score changed.
	ChangeUpdated
)

func (k ChangeKind) String() string {
	switch k {
	case ChangeRemoved:
		return "Removed"
	case ChangeAdded:
		return "Added"
	case ChangeUpdated:
		return "Updated"
	}
	return "Unknown"
}

// Change describes a single leaderboard difference. OldRank/OldScore are
// zero for added entries; NewRank/NewScore are zero for removed entries.
type Change struct {
	Group    string
	Kind     ChangeKind
	ID       string
	OldRank  int
	NewRank  int
	OldScore int64
	NewScore int64
}

// Sentinel errors returned by Apply.
var (
	ErrNotFound  = errors.New("dataeng: record not found")
	ErrInvalidOp = errors.New("dataeng: invalid operation")
)

type record struct {
	group string
	score int64
}

type member struct {
	id    string
	score int64
}

// lessMember orders by score descending, breaking ties by ID ascending in
// UTF-8 byte order (Go string comparison is byte-wise).
func lessMember(a, b member) bool {
	if a.score != b.score {
		return a.score > b.score
	}
	return a.id < b.id
}

// group holds the committed members of one group. Once committed, a *group
// is never mutated in place; batches clone touched groups so that readers
// holding old snapshots never observe a mutation.
type group struct {
	members map[string]int64
	sorted  []member // sorted by lessMember
}

func (g *group) clone() *group {
	members := make(map[string]int64, len(g.members))
	for id, score := range g.members {
		members[id] = score
	}
	sorted := make([]member, len(g.sorted))
	copy(sorted, g.sorted)
	return &group{members: members, sorted: sorted}
}

func (g *group) insert(id string, score int64) {
	m := member{id: id, score: score}
	i := sort.Search(len(g.sorted), func(i int) bool { return lessMember(m, g.sorted[i]) })
	g.sorted = append(g.sorted, member{})
	copy(g.sorted[i+1:], g.sorted[i:])
	g.sorted[i] = m
	g.members[id] = score
}

func (g *group) remove(id string) {
	score, ok := g.members[id]
	if !ok {
		return
	}
	delete(g.members, id)
	m := member{id: id, score: score}
	i := sort.Search(len(g.sorted), func(i int) bool { return !lessMember(g.sorted[i], m) })
	copy(g.sorted[i:], g.sorted[i+1:])
	g.sorted = g.sorted[:len(g.sorted)-1]
}

// Ranker maintains the current records of many groups and, for each group,
// the top-K leaderboard ordered by score descending with ties broken by ID
// ascending in UTF-8 byte order. It is safe for concurrent use: any number
// of read-only queries may run while a batch is being applied.
type Ranker struct {
	mu     sync.RWMutex
	k      int
	index  map[string]record
	groups map[string]*group
	boards map[string][]Entry // committed boards, never mutated in place
}

// New returns a Ranker that keeps the top K entries per group. K must be a
// positive integer; New panics otherwise.
func New(k int) *Ranker {
	if k <= 0 {
		panic("dataeng: K must be a positive integer")
	}
	return &Ranker{
		k:      k,
		index:  make(map[string]record),
		groups: make(map[string]*group),
		boards: make(map[string][]Entry),
	}
}

// K returns the board size the Ranker was created with.
func (r *Ranker) K() int { return r.k }

// Len returns the number of live records across all groups.
func (r *Ranker) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.index)
}

// Get returns the group and score of a record.
func (r *Ranker) Get(id string) (group string, score int64, ok bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	rec, ok := r.index[id]
	return rec.group, rec.score, ok
}

// Top returns a copy of the current top-K board of a group, or nil if the
// group does not exist. The returned slice is owned by the caller; boards
// returned by earlier calls are never affected by later batches.
func (r *Ranker) Top(group string) []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	board := r.boards[group]
	if len(board) == 0 {
		return nil
	}
	out := make([]Entry, len(board))
	copy(out, board)
	return out
}

// Apply executes a batch of ops in order and, on success, atomically commits
// the resulting state.
//
// If any op is invalid (unknown kind, empty ID or group) or deletes a
// non-existent ID, Apply returns an error and no state is changed. After the
// ops are applied, the top-K board of every touched group is recomputed and
// the difference from the old board to the new board is reported to emit as
// a single slice: groups in UTF-8 byte order, and within each group removals
// first (by old rank ascending) followed by additions and rank/score updates
// (by new rank ascending). An ID that moved groups is reported separately in
// each group. If the diff is empty or emit is nil, emit is not called.
//
// If emit returns an error, Apply returns it and the batch is not committed;
// the caller may retry the same batch later. emit is invoked while the
// Ranker is write-locked and must not call back into it.
func (r *Ranker) Apply(batch []Op, emit func([]Change) error) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	touched := make(map[string]*group)
	overlay := make(map[string]record)   // pending upserts
	removed := make(map[string]struct{}) // pending deletes

	lookup := func(id string) (record, bool) {
		if _, gone := removed[id]; gone {
			return record{}, false
		}
		if rec, ok := overlay[id]; ok {
			return rec, true
		}
		rec, ok := r.index[id]
		return rec, ok
	}
	touch := func(name string) *group {
		g, ok := touched[name]
		if !ok {
			if base := r.groups[name]; base != nil {
				g = base.clone()
			} else {
				g = &group{members: make(map[string]int64)}
			}
			touched[name] = g
		}
		return g
	}

	for i, op := range batch {
		switch op.Kind {
		case OpUpsert:
			if op.ID == "" || op.Group == "" {
				return fmt.Errorf("dataeng: batch op %d: %w: empty id or group", i, ErrInvalidOp)
			}
			if cur, ok := lookup(op.ID); ok {
				touch(cur.group).remove(op.ID)
			}
			touch(op.Group).insert(op.ID, op.Score)
			overlay[op.ID] = record{group: op.Group, score: op.Score}
			delete(removed, op.ID)
		case OpDelete:
			if op.ID == "" {
				return fmt.Errorf("dataeng: batch op %d: %w: empty id", i, ErrInvalidOp)
			}
			cur, ok := lookup(op.ID)
			if !ok {
				return fmt.Errorf("dataeng: batch op %d: delete %q: %w", i, op.ID, ErrNotFound)
			}
			touch(cur.group).remove(op.ID)
			delete(overlay, op.ID)
			removed[op.ID] = struct{}{}
		default:
			return fmt.Errorf("dataeng: batch op %d: %w: unknown kind %d", i, ErrInvalidOp, op.Kind)
		}
	}

	names := make([]string, 0, len(touched))
	for name := range touched {
		names = append(names, name)
	}
	sort.Strings(names)

	var changes []Change
	newBoards := make(map[string][]Entry, len(names))
	for _, name := range names {
		board := buildBoard(touched[name], r.k)
		newBoards[name] = board
		changes = append(changes, diffBoards(name, r.boards[name], board)...)
	}

	if len(changes) > 0 && emit != nil {
		if err := emit(changes); err != nil {
			return fmt.Errorf("dataeng: emit changes: %w", err)
		}
	}

	// Commit: nothing above mutated committed state, so reaching this point
	// means the batch is durable.
	for id, rec := range overlay {
		r.index[id] = rec
	}
	for id := range removed {
		delete(r.index, id)
	}
	for _, name := range names {
		g := touched[name]
		if len(g.members) == 0 {
			delete(r.groups, name)
			delete(r.boards, name)
			continue
		}
		r.groups[name] = g
		r.boards[name] = newBoards[name]
	}
	return nil
}

// buildBoard returns the top-k entries of a group in rank order.
func buildBoard(g *group, k int) []Entry {
	n := len(g.sorted)
	if n > k {
		n = k
	}
	board := make([]Entry, n)
	for i := 0; i < n; i++ {
		board[i] = Entry{Rank: i + 1, ID: g.sorted[i].id, Score: g.sorted[i].score}
	}
	return board
}

// diffBoards computes the changes between an old and a new board: removals
// in old-rank order, then additions and updates in new-rank order.
func diffBoards(name string, oldBoard, newBoard []Entry) []Change {
	newByID := make(map[string]Entry, len(newBoard))
	for _, e := range newBoard {
		newByID[e.ID] = e
	}
	oldByID := make(map[string]Entry, len(oldBoard))
	for _, e := range oldBoard {
		oldByID[e.ID] = e
	}

	var changes []Change
	for _, e := range oldBoard {
		if _, ok := newByID[e.ID]; !ok {
			changes = append(changes, Change{
				Group: name, Kind: ChangeRemoved, ID: e.ID,
				OldRank: e.Rank, OldScore: e.Score,
			})
		}
	}
	for _, e := range newBoard {
		old, ok := oldByID[e.ID]
		switch {
		case !ok:
			changes = append(changes, Change{
				Group: name, Kind: ChangeAdded, ID: e.ID,
				NewRank: e.Rank, NewScore: e.Score,
			})
		case old.Rank != e.Rank || old.Score != e.Score:
			changes = append(changes, Change{
				Group: name, Kind: ChangeUpdated, ID: e.ID,
				OldRank: old.Rank, NewRank: e.Rank,
				OldScore: old.Score, NewScore: e.Score,
			})
		}
	}
	return changes
}
