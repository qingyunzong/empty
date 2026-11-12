package triejoin

import (
	"encoding/binary"
	"sort"
)

// referenceJoin independently computes the natural join by enumerating the full
// Cartesian product of the (already deduplicated) input relations, applying
// equality constraints on shared columns, and projecting onto the global
// variable order. It deliberately uses no trie machinery, so it cross-checks
// the leapfrog engine on small data.
func referenceJoin(vars []string, rels []Relation) [][]int64 {
	deduped := make([]dedupRelation, 0, len(rels))
	for _, rel := range rels {
		d := dedupRelation{id: rel.ID, cols: append([]string(nil), rel.Columns...)}
		seen := map[string]bool{}
		for _, tup := range rel.Tuples {
			key := tupleKey(tup)
			if seen[key] {
				continue
			}
			seen[key] = true
			d.rows = append(d.rows, append([]int64(nil), tup...))
		}
		deduped = append(deduped, d)
	}

	assignment := map[string]int64{}
	var out [][]int64
	var recurse func(int)
	recurse = func(i int) {
		if i == len(deduped) {
			row := make([]int64, len(vars))
			for j, v := range vars {
				row[j] = assignment[v]
			}
			out = append(out, row)
			return
		}
		rel := deduped[i]
	outer:
		for _, tup := range rel.rows {
			for j, col := range rel.cols {
				if got, ok := assignment[col]; ok && got != tup[j] {
					continue outer
				}
			}
			bound := make([]string, 0, len(rel.cols))
			for j, col := range rel.cols {
				if _, ok := assignment[col]; !ok {
					assignment[col] = tup[j]
					bound = append(bound, col)
				}
			}
			recurse(i + 1)
			for _, col := range bound {
				delete(assignment, col)
			}
		}
	}
	recurse(0)

	seen := map[string]bool{}
	uniq := make([][]int64, 0, len(out))
	for _, row := range out {
		key := tupleKey(row)
		if seen[key] {
			continue
		}
		seen[key] = true
		uniq = append(uniq, row)
	}
	sort.Slice(uniq, func(i, j int) bool { return tupleLess(uniq[i], uniq[j]) })
	return uniq
}

type dedupRelation struct {
	id   string
	cols []string
	rows [][]int64
}

func tupleKey(row []int64) string {
	buf := make([]byte, 0, 8*len(row))
	for _, v := range row {
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(v)^(1<<63))
		buf = append(buf, b[:]...)
	}
	return string(buf)
}

func drain(it ResultIterator) ([][]int64, Counts, error) {
	var got [][]int64
	for {
		tup, ok, err := it.Next()
		if err != nil {
			return nil, Counts{}, err
		}
		if !ok {
			return got, it.Counts(), nil
		}
		got = append(got, tup)
	}
}
