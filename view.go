package formal

// FoldChanges applies a changelog onto an empty materialized view and returns
// the resulting rows keyed by window start then end. Add upserts the row,
// Retract removes the row with the same window key.
func FoldChanges(changes []Change) map[int64]map[int64]Row {
	view := make(map[int64]map[int64]Row)
	for _, change := range changes {
		group, ok := view[change.Row.Window.Start]
		if !ok {
			group = make(map[int64]Row)
			view[change.Row.Window.Start] = group
		}
		switch change.Kind {
		case Add:
			group[change.Row.Window.End] = change.Row
		case Retract:
			delete(group, change.Row.Window.End)
			if len(group) == 0 {
				delete(view, change.Row.Window.Start)
			}
		}
	}
	return view
}

// ViewRows flattens a folded view into rows sorted by (Start, End).
func ViewRows(view map[int64]map[int64]Row) []Row {
	starts := sortedKeys(view)
	rows := make([]Row, 0)
	for _, start := range starts {
		ends := sortedKeys(view[start])
		for _, end := range ends {
			rows = append(rows, view[start][end])
		}
	}
	return rows
}

func sortedKeys[V any](m map[int64]V) []int64 {
	keys := make([]int64, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	for i := 1; i < len(keys); i++ {
		for j := i; j > 0 && keys[j-1] > keys[j]; j-- {
			keys[j-1], keys[j] = keys[j], keys[j-1]
		}
	}
	return keys
}
