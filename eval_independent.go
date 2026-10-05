package main

import "sort"

// RejectedIndependent is a second, deliberately separate implementation of
// the public semantics, used only to cross-check Rejected. It walks the
// inheritance layers from the most specific (highest) layer downward instead
// of computing max-layer aggregates:
//
//   - find the highest layer that has any matching rule;
//   - deny-priority: if that layer contains a matching DENY, the request is
//     rejected provided some ALLOW matched anywhere (otherwise the deny is
//     moot under the default-ACCEPT policy);
//   - otherwise the top layer granted the request, so it is accepted.
func RejectedIndependent(rules []Rule, q int) bool {
	layers := map[int][]Rule{}
	top := -1
	anyAllow := false
	for _, r := range rules {
		if !r.Matches(q) {
			continue
		}
		layers[r.Layer] = append(layers[r.Layer], r)
		if r.Layer > top {
			top = r.Layer
		}
		if r.Act == Allow {
			anyAllow = true
		}
	}
	if top < 0 || !anyAllow {
		return false
	}
	keys := make([]int, 0, len(layers))
	for l := range layers {
		keys = append(keys, l)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(keys)))
	for _, l := range keys {
		for _, r := range layers[l] {
			if r.Act == Deny {
				return true // deny-priority at the deciding layer
			}
		}
		return false // top layer allows; inherited grants stand
	}
	return false
}
