package matrixlib

import "sort"

func sortChanges(cs []Change) {
	sort.Slice(cs, func(i, j int) bool {
		if cs[i].Matrix != cs[j].Matrix {
			return cs[i].Matrix < cs[j].Matrix
		}
		if cs[i].Row != cs[j].Row {
			return cs[i].Row < cs[j].Row
		}
		return cs[i].Col < cs[j].Col
	})
}
