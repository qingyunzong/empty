package stats

import "sort"

// refStore 是测试用的朴素参考实现：不做任何增量索引，
// 每次查询都从每个用户的本地副本出发全量解析、全量排序，
// 用于对照 Store 的归属索引与序统计索引维护是否正确。
type refStore struct {
	n       int
	copies  map[string]map[string]Event // 用户 -> 事件 ID -> 本地副本
	canon   map[string]string           // 事件 ID -> 权威属主
	groups  [][]string                  // 别名组成员列表（每组升序）
	origins map[string][][]string       // 组标识 -> 归并前来源组
}

func newRefStore(n int) *refStore {
	return &refStore{
		n:       n,
		copies:  map[string]map[string]Event{},
		canon:   map[string]string{},
		origins: map[string][][]string{},
	}
}

func (r *refStore) groupIdx(user string) int {
	for i, ms := range r.groups {
		for _, m := range ms {
			if m == user {
				return i
			}
		}
	}
	return -1
}

func (r *refStore) ensureUser(u string) {
	if r.groupIdx(u) < 0 {
		r.groups = append(r.groups, []string{u})
	}
}

func (r *refStore) upsert(e Event) {
	if owner, ok := r.canon[e.ID]; ok {
		delete(r.copies[owner], e.ID)
	}
	r.ensureUser(e.Owner)
	if r.copies[e.Owner] == nil {
		r.copies[e.Owner] = map[string]Event{}
	}
	r.copies[e.Owner][e.ID] = e
	r.canon[e.ID] = e.Owner
}

func (r *refStore) inject(e Event) {
	r.ensureUser(e.Owner)
	if r.copies[e.Owner] == nil {
		r.copies[e.Owner] = map[string]Event{}
	}
	r.copies[e.Owner][e.ID] = e
	if _, ok := r.canon[e.ID]; !ok {
		r.canon[e.ID] = e.Owner
	}
}

func (r *refStore) merge(users ...string) {
	idxSet := map[int]bool{}
	for _, u := range users {
		r.ensureUser(u)
		idxSet[r.groupIdx(u)] = true
	}
	if len(idxSet) < 2 {
		return
	}
	memberSet := map[string]bool{}
	var origins [][]string
	var remaining [][]string
	for i, ms := range r.groups {
		if !idxSet[i] {
			remaining = append(remaining, ms)
			continue
		}
		if o, ok := r.origins[ms[0]]; ok {
			origins = append(origins, o...)
			delete(r.origins, ms[0])
		} else {
			origins = append(origins, ms)
		}
		for _, m := range ms {
			memberSet[m] = true
		}
	}
	var members []string
	for m := range memberSet {
		members = append(members, m)
	}
	sort.Strings(members)
	r.groups = append(remaining, members)
	r.origins[members[0]] = origins
}

func (r *refStore) split(user string) bool {
	i := r.groupIdx(user)
	if i < 0 {
		return false
	}
	ms := r.groups[i]
	o, ok := r.origins[ms[0]]
	if !ok {
		return false
	}
	delete(r.origins, ms[0])
	r.groups = append(r.groups[:i], r.groups[i+1:]...)
	r.groups = append(r.groups, o...)
	return true
}

// view 全量解析 user 所在组：收集成员全部本地副本，按确定性规则
// 选出每个 ID 的保留事件，其余去重/隔离，最后全量排序。
func (r *refStore) view(user string) (live []Event, supp []Event, members []string, ok bool) {
	i := r.groupIdx(user)
	if i < 0 {
		return nil, nil, nil, false
	}
	members = r.groups[i]
	mset := map[string]bool{}
	var copies []Event
	for _, m := range members {
		mset[m] = true
		for _, e := range r.copies[m] {
			copies = append(copies, e)
		}
	}
	byID := map[string][]Event{}
	for _, c := range copies {
		byID[c.ID] = append(byID[c.ID], c)
	}
	for id, cs := range byID {
		winner := cs[0]
		canonical := false
		if owner, ok := r.canon[id]; ok && mset[owner] {
			for _, c := range cs {
				if c.Owner == owner {
					winner = c
					canonical = true
				}
			}
		}
		if !canonical {
			for _, c := range cs[1:] {
				if c.Owner < winner.Owner {
					winner = c
				}
			}
		}
		live = append(live, winner)
		for _, c := range cs {
			if c.Owner != winner.Owner {
				supp = append(supp, c)
			}
		}
	}
	sort.Slice(live, func(i, j int) bool { return lessEvent(live[i], live[j]) })
	return live, supp, members, true
}

func (r *refStore) snapshot(user string) (Snapshot, bool) {
	live, _, members, ok := r.view(user)
	if !ok {
		return Snapshot{}, false
	}
	total := len(live)
	w := r.n
	if w > total {
		w = total
	}
	var scores []float64
	for _, e := range live[total-w:] {
		scores = append(scores, e.Score)
	}
	sort.Float64s(scores)
	var med float64
	if w > 0 {
		if w%2 == 1 {
			med = scores[w/2]
		} else {
			med = (scores[w/2-1] + scores[w/2]) / 2
		}
	}
	return Snapshot{
		Group:   members[0],
		Members: members,
		Total:   total,
		Window:  w,
		Median:  med,
	}, true
}

func (r *refStore) isolated(user string) []Event {
	live, supp, _, ok := r.view(user)
	if !ok {
		return nil
	}
	winnerByID := map[string]Event{}
	for _, e := range live {
		winnerByID[e.ID] = e
	}
	var out []Event
	for _, sp := range supp {
		if w, found := winnerByID[sp.ID]; found && (sp.Time != w.Time || sp.Score != w.Score) {
			out = append(out, sp)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Time != b.Time {
			return a.Time < b.Time
		}
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		return a.Owner < b.Owner
	})
	return out
}
