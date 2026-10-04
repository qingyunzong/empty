// Package dict implements a persistent dictionary with fuzzy retrieval.
//
// Words are stored in an immutable trie. Add and Remove return a new
// Snapshot that shares structure with the receiver, so older snapshots
// remain valid and unchanged. Search returns every word whose Levenshtein
// distance from the query (code point insert/delete/replace) is at most
// the given limit, ranked by distance ascending, frequency descending,
// then byte order ascending.
package dict

import (
	"sort"
	"strings"
)

// MaxDistance is the default retrieval radius used by Search.
const MaxDistance = 2

type node struct {
	terminal bool
	freq     int
	children map[rune]*node
}

// Snapshot is an immutable view of the dictionary at one point in time.
type Snapshot struct {
	root *node
	size int
}

// New returns an empty dictionary snapshot.
func New() *Snapshot { return &Snapshot{} }

// Len reports how many words the snapshot contains.
func (s *Snapshot) Len() int { return s.size }

// Freq returns the frequency of word and whether it is present.
func (s *Snapshot) Freq(word string) (int, bool) {
	n := s.root
	for _, r := range word {
		if n == nil {
			return 0, false
		}
		n = n.children[r]
	}
	if n == nil || !n.terminal {
		return 0, false
	}
	return n.freq, true
}

// Add returns a new snapshot with word stored at the given frequency.
// The receiver is not modified. A non-positive frequency removes the word.
func (s *Snapshot) Add(word string, freq int) *Snapshot {
	if freq <= 0 {
		return s.Remove(word)
	}
	runes := []rune(word)
	_, existed := s.Freq(word)
	root := s.root.insert(runes, freq)
	size := s.size
	if !existed {
		size++
	}
	return &Snapshot{root: root, size: size}
}

// Remove returns a new snapshot without word. The receiver is not modified.
func (s *Snapshot) Remove(word string) *Snapshot {
	if _, ok := s.Freq(word); !ok {
		return s
	}
	root, _ := s.root.remove([]rune(word))
	return &Snapshot{root: root, size: s.size - 1}
}

func (n *node) insert(word []rune, freq int) *node {
	cp := &node{}
	if n != nil {
		*cp = *n
	}
	if len(word) == 0 {
		cp.terminal = true
		cp.freq = freq
		return cp
	}
	children := make(map[rune]*node, len(cp.children)+1)
	for r, c := range cp.children {
		children[r] = c
	}
	r := word[0]
	children[r] = cp.children[r].insert(word[1:], freq)
	cp.children = children
	return cp
}

// remove deletes word below n, returning the replacement node (nil when the
// subtree became empty) and whether the subtree is now empty.
func (n *node) remove(word []rune) (*node, bool) {
	if n == nil {
		return nil, true
	}
	cp := *n
	if len(word) == 0 {
		cp.terminal = false
		cp.freq = 0
	} else {
		r := word[0]
		child, empty := cp.children[r].remove(word[1:])
		if empty {
			children := make(map[rune]*node, len(cp.children))
			for cr, c := range cp.children {
				if cr != r {
					children[cr] = c
				}
			}
			cp.children = children
		} else {
			children := make(map[rune]*node, len(cp.children))
			for cr, c := range cp.children {
				children[cr] = c
			}
			children[r] = child
			cp.children = children
		}
	}
	if !cp.terminal && len(cp.children) == 0 {
		return nil, true
	}
	return &cp, false
}

// Result is one retrieved word.
type Result struct {
	Word     string
	Distance int
	Freq     int
}

// Stats describes the work performed by a search.
type Stats struct {
	// NodesVisited is the number of trie nodes for which a DP row was
	// computed, including the root.
	NodesVisited int
}

// Search returns words within MaxDistance of query, ranked by distance
// ascending, frequency descending, then byte order ascending.
func (s *Snapshot) Search(query string) ([]Result, Stats) {
	return s.SearchWithin(query, MaxDistance)
}

// SearchWithin is Search with an explicit distance limit.
func (s *Snapshot) SearchWithin(query string, maxDist int) ([]Result, Stats) {
	var stats Stats
	if s.root == nil || maxDist < 0 {
		return nil, stats
	}
	q := []rune(query)
	row := make([]int, len(q)+1)
	for i := range row {
		row[i] = i
	}
	var results []Result
	stats.NodesVisited++
	if s.root.terminal && row[len(q)] <= maxDist {
		results = append(results, Result{Word: "", Distance: row[len(q)], Freq: s.root.freq})
	}
	for _, r := range sortedRunes(s.root.children) {
		walk(s.root.children[r], r, []rune{r}, row, q, maxDist, &results, &stats)
	}
	sort.Slice(results, func(i, j int) bool {
		a, b := results[i], results[j]
		if a.Distance != b.Distance {
			return a.Distance < b.Distance
		}
		if a.Freq != b.Freq {
			return a.Freq > b.Freq
		}
		return strings.Compare(a.Word, b.Word) < 0
	})
	return results, stats
}

// walk computes the Levenshtein DP row for the trie node reached by
// appending r to the path of prevRow, then recurses while any entry in the
// row stays within maxDist.
func walk(n *node, r rune, prefix []rune, prevRow []int, q []rune, maxDist int, results *[]Result, stats *Stats) {
	row := make([]int, len(q)+1)
	row[0] = prevRow[0] + 1
	min := row[0]
	for j := 1; j <= len(q); j++ {
		cost := 0
		if q[j-1] != r {
			cost = 1
		}
		row[j] = minOf3(prevRow[j]+1, row[j-1]+1, prevRow[j-1]+cost)
		if row[j] < min {
			min = row[j]
		}
	}
	stats.NodesVisited++
	if n.terminal && row[len(q)] <= maxDist {
		*results = append(*results, Result{Word: string(prefix), Distance: row[len(q)], Freq: n.freq})
	}
	if min > maxDist {
		return
	}
	for _, cr := range sortedRunes(n.children) {
		walk(n.children[cr], cr, append(prefix, cr), row, q, maxDist, results, stats)
	}
}

func sortedRunes(m map[rune]*node) []rune {
	rs := make([]rune, 0, len(m))
	for r := range m {
		rs = append(rs, r)
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i] < rs[j] })
	return rs
}

func minOf3(a, b, c int) int {
	if a > b {
		a = b
	}
	if a > c {
		a = c
	}
	return a
}
