// Package dictsearch implements a persistent dictionary with fuzzy
// retrieval: it returns all words within edit distance 2 of a query,
// where edits are code-point (rune) insertions, deletions and
// substitutions with unit cost.
//
// Add and Remove return new snapshots; previously obtained snapshots
// are never modified (path-copying persistence).
package dictsearch

import "sort"

// MaxDistance is the maximum edit distance used by Search.
const MaxDistance = 2

// node is an immutable trie node. Snapshots share unchanged subtrees.
type node struct {
	children map[rune]*node
	freq     int // >0 marks a terminal word with its frequency
}

func (n *node) clone() *node {
	c := &node{freq: n.freq}
	if len(n.children) > 0 {
		c.children = make(map[rune]*node, len(n.children))
		for r, child := range n.children {
			c.children[r] = child
		}
	}
	return c
}

// Dictionary is an immutable snapshot of a word set with frequencies.
type Dictionary struct {
	root *node
	size int // number of distinct words
}

// New returns an empty dictionary.
func New() *Dictionary {
	return &Dictionary{root: &node{}}
}

// Len returns the number of distinct words in the snapshot.
func (d *Dictionary) Len() int { return d.size }

// Freq returns the frequency of word in the snapshot (0 if absent).
func (d *Dictionary) Freq(word string) int {
	n := d.root
	for _, r := range word {
		n = n.children[r]
		if n == nil {
			return 0
		}
	}
	return n.freq
}

// Add returns a new snapshot with word's frequency incremented by one.
// The receiver is unchanged.
func (d *Dictionary) Add(word string) *Dictionary {
	root, added := add(d.root, []rune(word), 0)
	size := d.size
	if added {
		size++
	}
	return &Dictionary{root: root, size: size}
}

func add(n *node, rs []rune, depth int) (*node, bool) {
	c := n.clone()
	if depth == len(rs) {
		added := c.freq == 0
		c.freq++
		return c, added
	}
	r := rs[depth]
	child := c.children[r]
	if child == nil {
		child = &node{}
	}
	newChild, added := add(child, rs, depth+1)
	if c.children == nil {
		c.children = make(map[rune]*node, 1)
	}
	c.children[r] = newChild
	return c, added
}

// Remove returns a new snapshot with word's frequency decremented by
// one; the word disappears when its frequency reaches zero. Removing
// an absent word returns an equivalent snapshot. The receiver is
// unchanged.
func (d *Dictionary) Remove(word string) *Dictionary {
	if d.Freq(word) == 0 {
		return d
	}
	root, removed := remove(d.root, []rune(word), 0)
	size := d.size
	if removed {
		size--
	}
	return &Dictionary{root: root, size: size}
}

func remove(n *node, rs []rune, depth int) (*node, bool) {
	c := n.clone()
	if depth == len(rs) {
		c.freq--
		return c, c.freq == 0
	}
	r := rs[depth]
	newChild, removed := remove(c.children[r], rs, depth+1)
	c.children[r] = newChild
	return c, removed
}

// Words returns all distinct words in byte order.
func (d *Dictionary) Words() []string {
	var words []string
	var walk func(n *node, prefix []rune)
	walk = func(n *node, prefix []rune) {
		if n.freq > 0 {
			words = append(words, string(prefix))
		}
		for _, r := range sortedRunes(n.children) {
			walk(n.children[r], append(prefix, r))
		}
	}
	walk(d.root, nil)
	return words
}

// NodeCount returns the number of trie nodes in the snapshot,
// including shared structure and the root.
func (d *Dictionary) NodeCount() int {
	count := 0
	var walk func(n *node)
	walk = func(n *node) {
		count++
		for _, child := range n.children {
			walk(child)
		}
	}
	walk(d.root)
	return count
}

// Match is a single search hit.
type Match struct {
	Word     string
	Distance int
	Freq     int
}

// Stats reports search effort.
type Stats struct {
	// NodesVisited is the number of trie nodes actually visited
	// (the root plus every node whose DP row was computed).
	NodesVisited int
}

// Search returns every word within edit distance MaxDistance of query,
// ranked by distance ascending, then frequency descending, then byte
// order ascending. Distances are Levenshtein distances over code
// points with unit-cost insertion, deletion and substitution.
func (d *Dictionary) Search(query string) ([]Match, Stats) {
	qr := []rune(query)
	m := len(qr)

	// Initial DP row: distance from query[:j] to the empty prefix.
	row := make([]int, m+1)
	for j := range row {
		row[j] = j
	}

	var matches []Match
	stats := Stats{NodesVisited: 1} // the root

	if d.root.freq > 0 && row[m] <= MaxDistance {
		matches = append(matches, Match{Word: "", Distance: row[m], Freq: d.root.freq})
	}

	var walk func(n *node, prefix []rune, prev []int)
	walk = func(n *node, prefix []rune, prev []int) {
		for _, r := range sortedRunes(n.children) {
			child := n.children[r]
			stats.NodesVisited++

			cur := make([]int, m+1)
			cur[0] = prev[0] + 1
			rowMin := cur[0]
			for j := 1; j <= m; j++ {
				cost := 0
				if qr[j-1] != r {
					cost = 1
				}
				cur[j] = min3(cur[j-1]+1, prev[j]+1, prev[j-1]+cost)
				if cur[j] < rowMin {
					rowMin = cur[j]
				}
			}

			if child.freq > 0 && cur[m] <= MaxDistance {
				matches = append(matches, Match{
					Word:     string(append(prefix, r)),
					Distance: cur[m],
					Freq:     child.freq,
				})
			}
			if rowMin <= MaxDistance {
				walk(child, append(prefix, r), cur)
			}
		}
	}
	walk(d.root, nil, row)

	sort.Slice(matches, func(i, j int) bool { return less(matches[i], matches[j]) })
	return matches, stats
}

func less(a, b Match) bool {
	if a.Distance != b.Distance {
		return a.Distance < b.Distance
	}
	if a.Freq != b.Freq {
		return a.Freq > b.Freq
	}
	return a.Word < b.Word // Go string comparison is byte order
}

func sortedRunes(children map[rune]*node) []rune {
	rs := make([]rune, 0, len(children))
	for r := range children {
		rs = append(rs, r)
	}
	sort.Slice(rs, func(i, j int) bool { return rs[i] < rs[j] })
	return rs
}

func min3(a, b, c int) int {
	if a < b {
		if a < c {
			return a
		}
		return c
	}
	if b < c {
		return b
	}
	return c
}
