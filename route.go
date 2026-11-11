package q159

// route returns the cheapest path of edges from src to dst. An empty,
// non-nil path means src == dst. Ties on total cost are broken by the
// lexicographically smallest edge ID sequence.
//
// Computed paths live in this snapshot's cache, keyed first by source
// schema. Each graph version owns a distinct snapshot, so batches running on
// an old version can never populate or read another version's cache.
func (s *snapshot) route(src, dst SchemaID) ([]Edge, error) {
	if src == dst {
		return []Edge{}, nil
	}

	s.cacheMu.RLock()
	dstCache, ok := s.cache[src]
	var cached []Edge
	if ok {
		cached = dstCache[dst]
	}
	s.cacheMu.RUnlock()
	if ok {
		if cached == nil {
			return nil, ErrNoPath
		}
		return cached, nil
	}

	dist := s.shortestPaths(src)

	built := make(map[SchemaID][]Edge, len(dist))
	for v, node := range dist {
		if v == src {
			continue
		}
		ids := make([]EdgeID, 0, len(node.seq))
		for cur := v; cur != src; {
			edge := dist[cur].prev
			ids = append(ids, edge.ID)
			cur = edge.From
		}
		// ids were collected target -> source; reverse into path order.
		for l, r := 0, len(ids)-1; l < r; l, r = l+1, r-1 {
			ids[l], ids[r] = ids[r], ids[l]
		}
		path := make([]Edge, len(ids))
		for i, id := range ids {
			path[i] = s.all[id]
		}
		built[v] = path
	}

	s.cacheMu.Lock()
	s.cache[src] = built
	s.cacheMu.Unlock()

	if _, reachable := dist[dst]; !reachable {
		return nil, ErrNoPath
	}
	return built[dst], nil
}
