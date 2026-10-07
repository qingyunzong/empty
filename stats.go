// Package stats 按用户维护最近 n 个事件的中位数统计。
//
// 事件按 (业务时间, ID) 排序，窗口内偶数个事件取中间两项的平均分数。
// 支持更正（可迁移事件所属用户）、别名组归并（重组事件顺序、去重同 ID、
// 隔离冲突事件）与拆分（回到原来源、历史快照保持）。
//
// Store 内部原子维护两类索引：
//   - 归属索引：事件 ID -> 权威属主用户；
//   - 序统计索引：每个别名组内按 (Time, ID) 升序的保留事件列表。
//
// 每个公开操作都在同一把锁内完成两类索引的更新，对外不可见中间状态。
package stats

import (
	"sort"
	"sync"
)

// Event 是一条业务事件。ID 全局标识一次业务事件；Owner 为所属用户；
// Time 为业务时间；Score 为分数。
type Event struct {
	ID    string
	Owner string
	Time  int64
	Score float64
}

func lessEvent(a, b Event) bool {
	if a.Time != b.Time {
		return a.Time < b.Time
	}
	return a.ID < b.ID
}

// Snapshot 是某个别名组在某一时刻的统计快照。
type Snapshot struct {
	Group   string   // 组标识（组内最小用户名）
	Members []string // 组内用户（升序）
	Total   int      // 参与统计的保留事件总数
	Window  int      // 进入中位数窗口的事件数（<= n）
	Median  float64  // 最近 n 个事件分数的中位数
}

// group 是一个别名组：若干用户的并集，共享一份事件序统计索引。
type group struct {
	id      string // 组标识 = 组内最小用户名
	members map[string]struct{}
	live    []Event    // 序统计索引：按 (Time, ID) 升序，ID 唯一
	supp    []Event    // 被去重/隔离的同 ID 副本
	origins [][]string // 归并前的来源组成员列表；nil 表示从未归并
}

func (g *group) sortedMembers() []string {
	ms := make([]string, 0, len(g.members))
	for m := range g.members {
		ms = append(ms, m)
	}
	sort.Strings(ms)
	return ms
}

// insertLive 按 (Time, ID) 二分插入，维持序统计索引有序。
func (g *group) insertLive(e Event) {
	i := sort.Search(len(g.live), func(i int) bool { return !lessEvent(g.live[i], e) })
	g.live = append(g.live, Event{})
	copy(g.live[i+1:], g.live[i:])
	g.live[i] = e
}

func (g *group) removeLive(e Event) {
	i := sort.Search(len(g.live), func(i int) bool { return !lessEvent(g.live[i], e) })
	if i < len(g.live) && g.live[i] == e {
		g.live = append(g.live[:i], g.live[i+1:]...)
	}
}

func (g *group) findLive(id string) (Event, bool) {
	for _, e := range g.live {
		if e.ID == id {
			return e, true
		}
	}
	return Event{}, false
}

// suppress 将副本 e 置为被抑制状态（同 ID 的保留事件仍在组内）。
func (g *group) suppress(e Event) {
	g.supp = append(g.supp, e)
}

func (g *group) dropSuppressed(id, owner string) bool {
	for i, sp := range g.supp {
		if sp.ID == id && sp.Owner == owner {
			g.supp = append(g.supp[:i], g.supp[i+1:]...)
			return true
		}
	}
	return false
}

// promote 在保留事件被移走后，从同 ID 的被抑制副本中提升属主名字最小者。
func (g *group) promote(id string) {
	best := -1
	for i, sp := range g.supp {
		if sp.ID != id {
			continue
		}
		if best < 0 || sp.Owner < g.supp[best].Owner {
			best = i
		}
	}
	if best < 0 {
		return
	}
	e := g.supp[best]
	g.supp = append(g.supp[:best], g.supp[best+1:]...)
	g.insertLive(e)
}

// resolveCopies 对一组副本按确定性规则选出每个 ID 的保留事件：
// 权威属主（归属索引）在组内时其副本保留，否则保留属主名字最小的副本；
// 其余副本被抑制（去重或隔离）。返回有序的保留列表与抑制列表。
func resolveCopies(copies []Event, canon map[string]string, members map[string]struct{}) ([]Event, []Event) {
	byID := map[string][]Event{}
	for _, c := range copies {
		byID[c.ID] = append(byID[c.ID], c)
	}
	var live []Event
	var supp []Event
	for id, cs := range byID {
		winner := cs[0]
		canonical := false
		if owner, ok := canon[id]; ok {
			if _, member := members[owner]; member {
				for _, c := range cs {
					if c.Owner == owner {
						winner = c
						canonical = true
						break
					}
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
			if c.Owner == winner.Owner {
				continue
			}
			supp = append(supp, c)
		}
	}
	sort.Slice(live, func(i, j int) bool { return lessEvent(live[i], live[j]) })
	sort.Slice(supp, func(i, j int) bool {
		a, b := supp[i], supp[j]
		if a.Time != b.Time {
			return a.Time < b.Time
		}
		if a.ID != b.ID {
			return a.ID < b.ID
		}
		return a.Owner < b.Owner
	})
	return live, supp
}

// Store 并发安全地维护归属索引与序统计索引。
type Store struct {
	mu     sync.Mutex
	n      int
	groups map[string]*group // 组标识 -> 组
	userG  map[string]*group // 用户 -> 所属组
	canon  map[string]string // 归属索引：事件 ID -> 权威属主用户
}

// New 创建一个窗口大小为 n 的统计库（n < 1 时按 1 处理）。
func New(n int) *Store {
	if n < 1 {
		n = 1
	}
	return &Store{
		n:      n,
		groups: map[string]*group{},
		userG:  map[string]*group{},
		canon:  map[string]string{},
	}
}

func (s *Store) ensureGroupLocked(user string) *group {
	if g, ok := s.userG[user]; ok {
		return g
	}
	g := &group{id: user, members: map[string]struct{}{user: {}}}
	s.groups[user] = g
	s.userG[user] = g
	return g
}

// Upsert 新增或更正事件；若事件 ID 已存在则更新内容，所属用户变化时
// 将事件迁移到新属主所在组。返回发生变动的组快照（按组标识排序）。
func (s *Store) Upsert(e Event) []Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	affected := map[*group]struct{}{}
	if oldOwner, ok := s.canon[e.ID]; ok {
		g1 := s.userG[oldOwner]
		if l, found := g1.findLive(e.ID); found {
			g1.removeLive(l)
		}
		affected[g1] = struct{}{}
		// 权威副本迁出本组后，若组内仍有同 ID 副本，按规则提升一个。
		if _, member := g1.members[e.Owner]; !member {
			g1.promote(e.ID)
		}
	}
	g2 := s.ensureGroupLocked(e.Owner)
	if l, found := g2.findLive(e.ID); found {
		g2.removeLive(l)
		if l.Owner != e.Owner {
			// 权威副本优先，组内原有本地副本被隔离。
			g2.suppress(l)
		}
	}
	// 属主自己的旧副本（若被抑制）被本次更正覆盖。
	g2.dropSuppressed(e.ID, e.Owner)
	g2.insertLive(e)
	s.canon[e.ID] = e.Owner
	affected[g2] = struct{}{}
	return s.snapshotsLocked(affected)
}

// Inject 向用户所在组本地注入事件，不做全局更正；用于同一业务事件
// 被多个别名各自上报的场景。同 ID 副本按确定性规则去重或隔离。
// 返回发生变动的组快照。
func (s *Store) Inject(e Event) []Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.ensureGroupLocked(e.Owner)
	owner, hasCanon := s.canon[e.ID]
	switch {
	case !hasCanon:
		s.canon[e.ID] = e.Owner
		g.insertLive(e)
	default:
		if _, member := g.members[owner]; member {
			if owner == e.Owner {
				// 覆盖自己的权威副本内容。
				if l, found := g.findLive(e.ID); found {
					g.removeLive(l)
				}
				g.insertLive(e)
			} else {
				g.dropSuppressed(e.ID, e.Owner)
				g.suppress(e)
			}
			break
		}
		// 权威副本不在本组：与组内现有保留副本比较，属主名字小者保留。
		g.dropSuppressed(e.ID, e.Owner)
		if l, found := g.findLive(e.ID); found {
			if l.Owner == e.Owner {
				// 覆盖自己的本地副本内容。
				g.removeLive(l)
				g.insertLive(e)
			} else if e.Owner < l.Owner {
				g.removeLive(l)
				g.suppress(l)
				g.insertLive(e)
			} else {
				g.suppress(e)
			}
		} else {
			g.insertLive(e)
		}
	}
	return s.snapshotsLocked(map[*group]struct{}{g: {}})
}

// Merge 将若干用户归并为一个别名组：重组事件顺序、去重同 ID、
// 隔离冲突副本。返回新组快照；用户不足两组时返回当前组快照。
func (s *Store) Merge(users ...string) []Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	set := map[*group]struct{}{}
	for _, u := range users {
		set[s.ensureGroupLocked(u)] = struct{}{}
	}
	gs := make([]*group, 0, len(set))
	for g := range set {
		gs = append(gs, g)
	}
	sort.Slice(gs, func(i, j int) bool { return gs[i].id < gs[j].id })
	if len(gs) < 2 {
		if len(gs) == 1 {
			return []Snapshot{s.snapshotLocked(gs[0])}
		}
		return nil
	}
	members := map[string]struct{}{}
	var origins [][]string
	var copies []Event
	for _, g := range gs {
		for m := range g.members {
			members[m] = struct{}{}
		}
		if g.origins != nil {
			origins = append(origins, g.origins...)
		} else {
			origins = append(origins, g.sortedMembers())
		}
		copies = append(copies, g.live...)
		for _, sp := range g.supp {
			copies = append(copies, sp)
		}
		delete(s.groups, g.id)
	}
	ng := &group{id: gs[0].id, members: members, origins: origins}
	ng.live, ng.supp = resolveCopies(copies, s.canon, members)
	s.groups[ng.id] = ng
	for m := range members {
		s.userG[m] = ng
	}
	return []Snapshot{s.snapshotLocked(ng)}
}

// Split 拆分 user 所在的别名组，恢复到归并前的来源组；各事件按所属
// 用户回到原来源组，归并前的历史快照得以保持。组从未归并时返回 false。
func (s *Store) Split(user string) ([]Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.userG[user]
	if !ok || g.origins == nil {
		return nil, false
	}
	copies := append([]Event{}, g.live...)
	for _, sp := range g.supp {
		copies = append(copies, sp)
	}
	delete(s.groups, g.id)
	restored := make([]*group, 0, len(g.origins))
	byUser := map[string]*group{}
	for _, ms := range g.origins {
		ng := &group{id: ms[0], members: map[string]struct{}{}}
		for _, m := range ms {
			ng.members[m] = struct{}{}
			s.userG[m] = ng
			byUser[m] = ng
		}
		s.groups[ng.id] = ng
		restored = append(restored, ng)
	}
	perG := map[*group][]Event{}
	for _, c := range copies {
		dst := byUser[c.Owner]
		perG[dst] = append(perG[dst], c)
	}
	affected := map[*group]struct{}{}
	for _, ng := range restored {
		ng.live, ng.supp = resolveCopies(perG[ng], s.canon, ng.members)
		affected[ng] = struct{}{}
	}
	return s.snapshotsLocked(affected), true
}

// Snapshot 返回 user 所在组的当前快照。
func (s *Store) Snapshot(user string) (Snapshot, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.userG[user]
	if !ok {
		return Snapshot{}, false
	}
	return s.snapshotLocked(g), true
}

// Median 返回 user 所在组最近 n 个事件分数的中位数；无事件时 ok 为 false。
func (s *Store) Median(user string) (median float64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, exists := s.userG[user]
	if !exists || len(g.live) == 0 {
		return 0, false
	}
	return s.snapshotLocked(g).Median, true
}

// Isolated 返回 user 所在组中被隔离的冲突事件（按时间、ID、属主排序）。
// 冲突判定相对于当前保留事件的内容动态进行。
func (s *Store) Isolated(user string) []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.userG[user]
	if !ok {
		return nil
	}
	var out []Event
	for _, sp := range g.supp {
		winner, found := g.findLive(sp.ID)
		if found && (sp.Time != winner.Time || sp.Score != winner.Score) {
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

func (s *Store) snapshotLocked(g *group) Snapshot {
	total := len(g.live)
	w := s.n
	if w > total {
		w = total
	}
	scores := make([]float64, 0, w)
	for _, e := range g.live[total-w:] {
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
		Group:   g.id,
		Members: g.sortedMembers(),
		Total:   total,
		Window:  w,
		Median:  med,
	}
}

func (s *Store) snapshotsLocked(set map[*group]struct{}) []Snapshot {
	gs := make([]*group, 0, len(set))
	for g := range set {
		gs = append(gs, g)
	}
	sort.Slice(gs, func(i, j int) bool { return gs[i].id < gs[j].id })
	snaps := make([]Snapshot, 0, len(gs))
	for _, g := range gs {
		snaps = append(snaps, s.snapshotLocked(g))
	}
	return snaps
}
