package objstore

import (
	"os"
	"sync"
)

// reasonUnreachable is the Evidence.Reason attached to swept objects.
const reasonUnreachable = "unreachable from all version roots and temp-upload lease expired"

// cycleState tracks a running GC mark-sweep cycle. It implements the
// write barrier: Put and SetRoot call add while a cycle is active, and
// anything they make reachable is marked so the sweeper never deletes
// a reachable object.
type cycleState struct {
	mu     sync.Mutex
	marked map[ID]bool
	queue  []ID
	done   bool // mark phase finished; add() marks eagerly from now on
	refs   func(ID) []ID
}

// add records newly reachable objects. Before the mark phase drains,
// ids are queued; after it, they are marked immediately together with
// their whole reference subtree.
func (c *cycleState) add(ids ...ID) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, id := range ids {
		if c.marked[id] {
			continue
		}
		if !c.done {
			c.queue = append(c.queue, id)
			continue
		}
		c.markSubtreeLocked(id)
	}
}

// markSubtreeLocked marks id and everything reachable from it. The id
// itself is marked even if its file is not on disk yet (a concurrent
// Put registers the barrier before the file rename becomes visible).
func (c *cycleState) markSubtreeLocked(id ID) {
	stack := []ID{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if c.marked[cur] {
			continue
		}
		c.marked[cur] = true
		for _, r := range c.refs(cur) {
			if !c.marked[r] {
				stack = append(stack, r)
			}
		}
	}
}

func (c *cycleState) isMarked(id ID) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.marked[id]
}

// Collect runs one mark-sweep GC cycle and returns the unreachability
// evidence for every deleted object. Phases:
//
//  1. snapshot roots + live temp-upload leases (journal: gc-begin)
//  2. mark everything reachable from the snapshot
//  3. sweep: for each unmarked, lease-expired object, journal a delete
//     record carrying Evidence, then remove the file
//  4. journal gc-end and compact the journal
//
// Concurrent Puts and SetRoots are safe: they act as write barriers
// through cycleState.add, and the final file removal re-checks the mark
// under the cycle lock.
func (s *Store) Collect() ([]Evidence, error) {
	s.gcMu.Lock()
	defer s.gcMu.Unlock()

	s.mu.Lock()
	s.cycleID++
	cyc := &cycleState{
		marked: make(map[ID]bool),
		refs: func(id ID) []ID {
			refs, _ := readHeaderRefs(s.objPath(id))
			return refs
		},
	}
	s.cycle = cyc
	cycleID := s.cycleID
	rootSnap := make(map[string]ID, len(s.roots))
	for k, v := range s.roots {
		rootSnap[k] = v
	}
	gen := s.rootGen
	now := s.now()
	var seeds []ID
	for _, id := range rootSnap {
		seeds = append(seeds, id)
	}
	for id, t := range s.temps {
		if now.Sub(t) < s.minAge {
			seeds = append(seeds, id)
		}
	}
	err := s.j.appendLocked(entry{Op: opGCBegin, Cycle: cycleID, Gen: gen})
	s.mu.Unlock()
	if err != nil {
		s.clearCycle()
		return nil, err
	}

	cyc.add(seeds...)
	if h := s.hooks.AfterRootSnapshot; h != nil {
		h()
	}

	// Mark phase: drain the queue. Write barriers may keep feeding it.
	for {
		cyc.mu.Lock()
		if len(cyc.queue) == 0 {
			cyc.done = true
			cyc.mu.Unlock()
			break
		}
		id := cyc.queue[0]
		cyc.queue = cyc.queue[1:]
		if cyc.marked[id] {
			cyc.mu.Unlock()
			continue
		}
		cyc.marked[id] = true
		cyc.mu.Unlock()
		refs, err := readHeaderRefs(s.objPath(id))
		if err != nil {
			continue // not (yet) on disk; conservative mark already applied
		}
		cyc.add(refs...)
	}

	if h := s.hooks.AfterMark; h != nil {
		h()
	}

	// Sweep phase.
	ids, err := s.listObjects()
	if err != nil {
		s.clearCycle()
		return nil, err
	}
	var evs []Evidence
	for _, id := range ids {
		if cyc.isMarked(id) {
			continue
		}
		s.mu.Lock()
		if t, ok := s.temps[id]; ok && s.now().Sub(t) < s.minAge {
			s.mu.Unlock()
			continue
		}
		delete(s.temps, id)
		cyc.mu.Lock()
		unmarked := !cyc.marked[id]
		markedCount := len(cyc.marked)
		cyc.mu.Unlock()
		if !unmarked {
			s.mu.Unlock()
			continue
		}
		ev := Evidence{
			Cycle:          cycleID,
			Object:         id,
			RootGeneration: gen,
			Roots:          cloneRoots(rootSnap),
			Marked:         markedCount,
			Reason:         reasonUnreachable,
			Time:           s.now(),
		}
		// Journal the deletion with its evidence before touching disk.
		err := s.j.appendLocked(entry{Op: opDelete, Cycle: cycleID, Ev: &ev})
		s.mu.Unlock()
		if err != nil {
			s.clearCycle()
			return evs, err
		}
		if h := s.hooks.BeforeDelete; h != nil {
			if err := h(id); err != nil {
				s.clearCycle()
				return evs, err
			}
		}
		// Final atomic re-check: a write barrier may have revived the
		// object while the hook ran.
		s.mu.Lock()
		cyc.mu.Lock()
		if !cyc.marked[id] {
			os.Remove(s.objPath(id))
			evs = append(evs, ev)
		}
		cyc.mu.Unlock()
		s.mu.Unlock()
	}

	s.mu.Lock()
	if !s.debugCrash {
		if err := s.j.appendLocked(entry{Op: opGCEnd, Cycle: cycleID}); err == nil {
			err = s.j.compactLocked(s.roots, s.temps, s.rootGen)
		}
		s.cycle = nil
		s.mu.Unlock()
		if err != nil {
			return evs, err
		}
	} else {
		s.cycle = nil
		s.mu.Unlock()
	}
	return evs, nil
}

func (s *Store) clearCycle() {
	s.mu.Lock()
	s.cycle = nil
	s.mu.Unlock()
}

func cloneRoots(in map[string]ID) map[string]ID {
	out := make(map[string]ID, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
