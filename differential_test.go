package stats

import (
	"fmt"
	"math/rand"
	"reflect"
	"slices"
	"sort"
	"testing"
)

// model 全量排序参考实现：与 Store 独立，每次都用完整排序重算窗口与中位数，
// 用于对随机操作历史（上报/更正/归并/拆分/恢复）做差分核对。
type model struct {
	n        int
	owned    map[string]map[string]Event // 属主 -> 事件 ID -> 事件
	memberOf map[string]string
	groups   map[string]*modelGroup
}

type modelGroup struct {
	members []string
	parked  map[string][]Event
}

func newModel(n int) *model {
	return &model{
		n:        n,
		owned:    map[string]map[string]Event{},
		memberOf: map[string]string{},
		groups:   map[string]*modelGroup{},
	}
}

func (m *model) resolve(user string) string {
	if g, ok := m.memberOf[user]; ok {
		return g
	}
	return user
}

func (m *model) ownersOf(id string) []string {
	var out []string
	for owner, events := range m.owned {
		if _, ok := events[id]; ok {
			out = append(out, owner)
		}
	}
	sort.Strings(out)
	return out
}

func sortedEvents(set map[string]Event) []Event {
	evs := make([]Event, 0, len(set))
	for _, ev := range set {
		evs = append(evs, ev)
	}
	sort.Slice(evs, func(i, j int) bool {
		if evs[i].Time != evs[j].Time {
			return evs[i].Time < evs[j].Time
		}
		return evs[i].ID < evs[j].ID
	})
	return evs
}

func (m *model) snapshotsOf(ids []string) map[string]Snapshot {
	out := map[string]Snapshot{}
	for _, id := range ids {
		if _, ok := out[id]; !ok {
			out[id] = m.rawSnapshot(id)
		}
	}
	return out
}

func (m *model) changed(affected []string, pre map[string]Snapshot) []Snapshot {
	seen := map[string]bool{}
	var out []Snapshot
	for _, id := range affected {
		if seen[id] {
			continue
		}
		seen[id] = true
		post := m.rawSnapshot(id)
		if equalSnapshot(pre[id], post) {
			continue
		}
		out = append(out, post)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Owner < out[j].Owner })
	return out
}

func (m *model) upsert(ev Event) ([]Snapshot, error) {
	if err := validateEvent(ev); err != nil {
		return nil, err
	}
	if _, isGroup := m.groups[ev.User]; isGroup {
		return nil, fmt.Errorf("group as user")
	}
	owner := m.resolve(ev.User)
	affected := []string{owner}
	pre := m.snapshotsOf(affected)
	if m.owned[owner] == nil {
		m.owned[owner] = map[string]Event{}
	}
	m.owned[owner][ev.ID] = ev
	return m.changed(affected, pre), nil
}

func (m *model) correct(ev Event) ([]Snapshot, error) {
	if err := validateEvent(ev); err != nil {
		return nil, err
	}
	if _, isGroup := m.groups[ev.User]; isGroup {
		return nil, fmt.Errorf("group as user")
	}
	owner := m.resolve(ev.User)
	owners := m.ownersOf(ev.ID)
	affected := append([]string{owner}, owners...)
	pre := m.snapshotsOf(affected)
	if slices.Contains(owners, owner) {
		m.owned[owner][ev.ID] = ev
	} else {
		if len(owners) > 0 {
			src := owners[0]
			delete(m.owned[src], ev.ID)
			if len(m.owned[src]) == 0 {
				delete(m.owned, src)
			}
		}
		if m.owned[owner] == nil {
			m.owned[owner] = map[string]Event{}
		}
		m.owned[owner][ev.ID] = ev
	}
	return m.changed(affected, pre), nil
}

func (m *model) merge(groupID string, members []string) ([]Snapshot, error) {
	if groupID == "" || len(members) == 0 {
		return nil, fmt.Errorf("bad merge")
	}
	if _, ok := m.owned[groupID]; ok {
		return nil, fmt.Errorf("id taken")
	}
	if _, ok := m.groups[groupID]; ok {
		return nil, fmt.Errorf("id taken")
	}
	if _, ok := m.memberOf[groupID]; ok {
		return nil, fmt.Errorf("id is alias")
	}
	seen := map[string]bool{}
	for _, mem := range members {
		if mem == "" || mem == groupID || seen[mem] {
			return nil, fmt.Errorf("bad member")
		}
		seen[mem] = true
		if _, ok := m.memberOf[mem]; ok {
			return nil, fmt.Errorf("member grouped")
		}
		if _, isGroup := m.groups[mem]; isGroup {
			return nil, fmt.Errorf("group as member")
		}
	}
	affected := append([]string{groupID}, members...)
	pre := m.snapshotsOf(affected)
	g := &modelGroup{members: slices.Clone(members), parked: map[string][]Event{}}
	canon := map[string]Event{}
	for _, mem := range members {
		for _, ev := range sortedEvents(m.owned[mem]) {
			if _, dup := canon[ev.ID]; dup {
				g.parked[ev.ID] = append(g.parked[ev.ID], ev)
			} else {
				canon[ev.ID] = ev
			}
		}
		delete(m.owned, mem)
		m.memberOf[mem] = groupID
	}
	m.owned[groupID] = canon
	m.groups[groupID] = g
	return m.changed(affected, pre), nil
}

func (m *model) split(groupID string) ([]Snapshot, error) {
	g, ok := m.groups[groupID]
	if !ok {
		return nil, fmt.Errorf("no group")
	}
	affected := append([]string{groupID}, g.members...)
	pre := m.snapshotsOf(affected)
	// 先恢复隔离副本，再恢复规范副本（规范副本优先）
	ids := make([]string, 0, len(g.parked))
	for id := range g.parked {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		for _, ev := range g.parked[id] {
			if m.owned[ev.User] == nil {
				m.owned[ev.User] = map[string]Event{}
			}
			m.owned[ev.User][ev.ID] = ev
		}
	}
	for _, ev := range sortedEvents(m.owned[groupID]) {
		if m.owned[ev.User] == nil {
			m.owned[ev.User] = map[string]Event{}
		}
		m.owned[ev.User][ev.ID] = ev
	}
	delete(m.owned, groupID)
	delete(m.groups, groupID)
	for _, mem := range g.members {
		delete(m.memberOf, mem)
	}
	return m.changed(affected, pre), nil
}

// rawSnapshot 全量排序重算：排序全部事件取末尾 n 个，再排序分数取中位数。
func (m *model) rawSnapshot(id string) Snapshot {
	evs := sortedEvents(m.owned[id])
	if len(evs) == 0 {
		return Snapshot{Owner: id}
	}
	if len(evs) > m.n {
		evs = evs[len(evs)-m.n:]
	}
	scores := make([]float64, 0, len(evs))
	var win []string
	for _, ev := range evs {
		scores = append(scores, ev.Score)
		win = append(win, ev.ID)
	}
	sort.Float64s(scores)
	return Snapshot{Owner: id, Count: len(evs), Median: median(scores), Window: win}
}

func (m *model) snapshot(id string) Snapshot {
	return m.rawSnapshot(m.resolve(id))
}

func equalSnapNoSeq(a, b Snapshot) bool {
	return a.Owner == b.Owner && equalSnapshot(a, b)
}

func equalSnapFull(a, b Snapshot) bool {
	return a.Seq == b.Seq && equalSnapNoSeq(a, b)
}

// runSimulation 执行一条随机操作历史，逐步将 Store 与全量排序参考模型对照：
// 变动用户快照、全量状态、隔离区、历史快照流都必须一致。返回最终历史快照流。
func runSimulation(t *testing.T, seed int64) []Snapshot {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	store := New(3)
	ref := newModel(3)
	users := []string{"u0", "u1", "u2", "u3", "u4", "u5"}
	ids := []string{"e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11"}
	var groupIDs []string
	groupSeq := 0
	histLen := 0

	checkState := func(step int) {
		names := append(slices.Clone(users), groupIDs...)
		names = append(names, "ghost")
		for _, name := range names {
			got := store.Snapshot(name)
			want := ref.snapshot(name)
			if !equalSnapFull(got, want) {
				t.Fatalf("seed=%d step=%d: 状态不一致 %s:\n got %+v\nwant %+v", seed, step, name, got, want)
			}
		}
		for gid, g := range ref.groups {
			if !reflect.DeepEqual(store.Quarantine(gid), g.parked) {
				t.Fatalf("seed=%d step=%d: 隔离区不一致 %s:\n got %v\nwant %v", seed, step, gid, store.Quarantine(gid), g.parked)
			}
		}
	}

	apply := func(step int, implFn func() ([]Snapshot, error), refFn func() ([]Snapshot, error)) {
		implOut, implErr := implFn()
		refOut, refErr := refFn()
		if (implErr != nil) != (refErr != nil) {
			t.Fatalf("seed=%d step=%d: 错误不一致 impl=%v ref=%v", seed, step, implErr, refErr)
		}
		if implErr != nil {
			checkState(step)
			return
		}
		if len(implOut) != len(refOut) {
			t.Fatalf("seed=%d step=%d: 变动快照数量不一致:\n got %+v\nwant %+v", seed, step, implOut, refOut)
		}
		for i := range implOut {
			if !equalSnapNoSeq(implOut[i], refOut[i]) {
				t.Fatalf("seed=%d step=%d: 变动快照不一致:\n got %+v\nwant %+v", seed, step, implOut, refOut)
			}
		}
		// 历史快照流尾部应正好追加本次输出
		h := store.History()
		if len(h) != histLen+len(implOut) {
			t.Fatalf("seed=%d step=%d: 历史长度不符 got %d want %d", seed, step, len(h), histLen+len(implOut))
		}
		for i, sn := range implOut {
			if !equalSnapFull(h[histLen+i], sn) {
				t.Fatalf("seed=%d step=%d: 历史尾部不符:\n got %+v\nwant %+v", seed, step, h[histLen+i], sn)
			}
		}
		histLen = len(h)
		checkState(step)
	}

	randomEvent := func() Event {
		return Event{
			ID:    ids[rng.Intn(len(ids))],
			User:  users[rng.Intn(len(users))],
			Time:  int64(rng.Intn(10)),
			Score: float64(rng.Intn(6)),
		}
	}
	doUpsert := func(step int) {
		ev := randomEvent()
		apply(step, func() ([]Snapshot, error) { return store.Upsert(ev) },
			func() ([]Snapshot, error) { return ref.upsert(ev) })
	}
	freeUsers := func() []string {
		var out []string
		for _, u := range users {
			if _, ok := ref.memberOf[u]; !ok {
				out = append(out, u)
			}
		}
		return out
	}
	existingGroups := func() []string {
		out := make([]string, 0, len(ref.groups))
		for gid := range ref.groups {
			out = append(out, gid)
		}
		sort.Strings(out)
		return out
	}

	for step := 0; step < 300; step++ {
		switch r := rng.Intn(100); {
		case r < 40: // 上报/更正（按用户）
			doUpsert(step)
		case r < 60: // 全局更正（可移动所属用户）
			ev := randomEvent()
			apply(step, func() ([]Snapshot, error) { return store.Correct(ev) },
				func() ([]Snapshot, error) { return ref.correct(ev) })
		case r < 72: // 归并别名组
			free := freeUsers()
			if len(free) < 2 {
				doUpsert(step)
				break
			}
			k := 2 + rng.Intn(min(3, len(free))-1)
			rng.Shuffle(len(free), func(i, j int) { free[i], free[j] = free[j], free[i] })
			members := slices.Clone(free[:k])
			gid := fmt.Sprintf("g%d", groupSeq)
			groupSeq++
			apply(step, func() ([]Snapshot, error) { return store.Merge(gid, members) },
				func() ([]Snapshot, error) { return ref.merge(gid, members) })
			groupIDs = append(groupIDs, gid)
		case r < 84: // 拆分（恢复来源）
			gs := existingGroups()
			if len(gs) == 0 {
				doUpsert(step)
				break
			}
			gid := gs[rng.Intn(len(gs))]
			apply(step, func() ([]Snapshot, error) { return store.Split(gid) },
				func() ([]Snapshot, error) { return ref.split(gid) })
		case r < 88: // 以组为用户上报（双方应报错）
			gs := existingGroups()
			if len(gs) == 0 {
				doUpsert(step)
				break
			}
			ev := randomEvent()
			ev.User = gs[rng.Intn(len(gs))]
			apply(step, func() ([]Snapshot, error) { return store.Upsert(ev) },
				func() ([]Snapshot, error) { return ref.upsert(ev) })
		case r < 92: // 非法归并（双方应报错）
			free := freeUsers()
			var members []string
			switch rng.Intn(3) {
			case 0: // 空成员
				members = nil
			case 1: // 重复成员
				if len(free) > 0 {
					members = []string{free[0], free[0]}
				}
			case 2: // 含已归并成员
				for _, u := range users {
					if _, ok := ref.memberOf[u]; ok {
						members = []string{u}
						break
					}
				}
				if len(free) > 0 {
					members = append(members, free[0])
				}
			}
			if len(members) == 0 && rng.Intn(2) == 0 {
				doUpsert(step)
				break
			}
			gid := fmt.Sprintf("bad%d", groupSeq)
			apply(step, func() ([]Snapshot, error) { return store.Merge(gid, members) },
				func() ([]Snapshot, error) { return ref.merge(gid, members) })
		default: // 纯查询核对
			checkState(step)
		}
	}
	// 收尾：拆分所有存活的别名组，恢复来源后再做全量对照
	for _, gid := range existingGroups() {
		apply(-1, func() ([]Snapshot, error) { return store.Split(gid) },
			func() ([]Snapshot, error) { return ref.split(gid) })
	}
	// 历史快照流 Seq 应严格递增
	h := store.History()
	for i, sn := range h {
		if sn.Seq != int64(i+1) {
			t.Fatalf("seed=%d: 历史 Seq 不连续: 第 %d 项 Seq=%d", seed, i, sn.Seq)
		}
	}
	return h
}

// 随机历史（上报/更正/归并/拆分/恢复）与全量排序参考实现逐步对照。
func TestRandomizedDifferential(t *testing.T) {
	for seed := int64(0); seed < 40; seed++ {
		runSimulation(t, seed)
	}
}

// 同一随机种子重放应得到完全一致的历史快照流。
func TestDeterministicReplay(t *testing.T) {
	first := runSimulation(t, 777)
	second := runSimulation(t, 777)
	if !reflect.DeepEqual(first, second) {
		t.Fatal("同种子重放结果不一致")
	}
	if len(first) == 0 {
		t.Fatal("历史快照流不应为空")
	}
}
