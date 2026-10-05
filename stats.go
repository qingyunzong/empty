// Package stats 按用户（或别名组）维护最近 n 个事件的中位数。
//
// 事件按 (业务时间 Time, ID) 排序，每个属主只保留排序后最大的 n 个事件
// 作为统计窗口，窗口内分数的中位数即统计结果；窗口大小为偶数时取中间
// 两项分数的平均值。
//
// Store 内部原子地维护两类索引（同一持锁临界区内一起更新）：
//   - 归属索引 ownerOf：事件 ID -> 属主实体集合；
//   - 序统计索引：每个实体的有序事件表 order 与窗口分数多重集 scores。
//
// 每个变更操作返回本次状态发生变化的用户/别名组快照，并追加到历史
// 快照流（History），历史快照在别名组拆分后依然保留。
package stats

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"sync"
)

// Event 业务事件。同一属主内 ID 唯一；不同用户可持有同 ID 事件。
type Event struct {
	ID    string
	User  string
	Time  int64   // 业务时间，排序主键
	Score float64 // 参与中位数统计的分数
}

// Snapshot 某个属主（用户或别名组）当前统计窗口的快照。
type Snapshot struct {
	Seq    int64    // 在历史快照流中的序号，查询接口返回 0
	Owner  string   // 属主 ID（用户或别名组）
	Count  int      // 窗口内事件数
	Median float64  // 窗口分数中位数，偶数取中间两项平均
	Window []string // 窗口内事件 ID，按 (Time, ID) 升序
}

// Store 统计库。并发安全。
type Store struct {
	n        int
	mu       sync.Mutex
	entities map[string]*entity         // 用户与别名组实体
	ownerOf  map[string]map[string]bool // 归属索引：事件 ID -> 属主集合
	memberOf map[string]string          // 用户 -> 所属别名组
	groups   map[string]*groupState     // 别名组 -> 归并状态
	history  []Snapshot                 // 历史快照流（只增不减）
	seq      int64
}

// New 创建保留最近 n 个事件的统计库。n 必须为正数。
func New(n int) *Store {
	if n <= 0 {
		panic("stats: n 必须为正数")
	}
	return &Store{
		n:        n,
		entities: map[string]*entity{},
		ownerOf:  map[string]map[string]bool{},
		memberOf: map[string]string{},
		groups:   map[string]*groupState{},
	}
}

// Upsert 上报或更正事件。
//
// 事件按（用户, ID）归属：若 User（经别名解析后的实体）已持有同 ID 事件，
// 则为原地更正；否则作为该用户的新事件插入，不影响其他用户持有的同 ID
// 事件（不同用户可各自持有同 ID 事件，归并时再去重）。
//
// User 若已归并入别名组，事件计入该组。不允许直接以别名组 ID 作为 User。
// 返回本次状态发生变化的属主快照（按 Owner 排序）。
func (s *Store) Upsert(ev Event) ([]Snapshot, error) {
	if err := validateEvent(ev); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, isGroup := s.groups[ev.User]; isGroup {
		return nil, fmt.Errorf("stats: 不能以别名组 %q 作为事件用户", ev.User)
	}
	owner := s.resolve(ev.User)
	affected := []string{owner}
	pre := s.snapshotsOf(affected)

	ent := s.ensureEntity(owner)
	if _, ok := ent.events[ev.ID]; ok {
		ent.remove(ev.ID, s.n)
	}
	cp := ev
	ent.insert(&cp, s.n)
	s.addOwner(ev.ID, owner)
	return s.emitChanged(affected, pre), nil
}

// Correct 按事件 ID 全局更正：更新事件内容，且当 ev.User 与当前属主不同
// 时把事件移动到新属主（更正可移动所属用户）。同一 ID 被多个属主持有时，
// 若 ev.User 所属实体持有该 ID 则只原地更正该副本；否则从字典序最小的
// 属主处移动，其余属主的副本不受影响。
//
// 返回本次状态发生变化的属主快照（按 Owner 排序）。
func (s *Store) Correct(ev Event) ([]Snapshot, error) {
	if err := validateEvent(ev); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, isGroup := s.groups[ev.User]; isGroup {
		return nil, fmt.Errorf("stats: 不能以别名组 %q 作为事件用户", ev.User)
	}
	owner := s.resolve(ev.User)
	owners := s.ownerOf[ev.ID]
	affected := []string{owner}
	for o := range owners {
		affected = append(affected, o)
	}
	pre := s.snapshotsOf(affected)

	switch {
	case owners[owner]:
		// 原地更正
		s.entities[owner].remove(ev.ID, s.n)
	case len(owners) > 0:
		// 移动所属：从字典序最小的属主处移除
		src := smallestKey(owners)
		s.entities[src].remove(ev.ID, s.n)
		delete(owners, src)
		if len(owners) == 0 {
			delete(s.ownerOf, ev.ID)
		}
		// 空的普通用户实体及时回收，避免占用组 ID 命名空间
		if _, isGroup := s.groups[src]; !isGroup && len(s.entities[src].events) == 0 {
			delete(s.entities, src)
		}
	}
	ent := s.ensureEntity(owner)
	cp := ev
	ent.insert(&cp, s.n)
	s.addOwner(ev.ID, owner)
	return s.emitChanged(affected, pre), nil
}

func validateEvent(ev Event) error {
	if ev.ID == "" || ev.User == "" {
		return errors.New("stats: 事件 ID 与 User 不能为空")
	}
	if math.IsNaN(ev.Score) {
		return errors.New("stats: Score 不能为 NaN")
	}
	return nil
}

// Snapshot 查询属主当前快照；若 id 是已归并用户的别名，返回其所属组的快照。
// 不存在的属主返回零值快照（Owner 为解析后的 id）。
func (s *Store) Snapshot(id string) Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.snapshotOrZero(s.resolve(id))
}

// History 返回历史快照流（每次变更输出的快照，按 Seq 递增）。
// 别名组拆分后，其存续期间的快照依然保留在历史中。
func (s *Store) History() []Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.history)
}

// Quarantine 返回别名组中被去重/冲突隔离的事件副本（事件 ID -> 副本列表，
// 副本的 User 字段即其来源用户）。组不存在时返回 nil。
func (s *Store) Quarantine(groupID string) map[string][]Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	g, ok := s.groups[groupID]
	if !ok {
		return nil
	}
	out := make(map[string][]Event, len(g.parked))
	for id, copies := range g.parked {
		out[id] = slices.Clone(copies)
	}
	return out
}

// resolve 将用户别名解析为实际属主实体 ID。
func (s *Store) resolve(user string) string {
	if g, ok := s.memberOf[user]; ok {
		return g
	}
	return user
}

func (s *Store) ensureEntity(id string) *entity {
	ent, ok := s.entities[id]
	if !ok {
		ent = &entity{id: id, events: map[string]*Event{}}
		s.entities[id] = ent
	}
	return ent
}

func (s *Store) addOwner(eventID, owner string) {
	set := s.ownerOf[eventID]
	if set == nil {
		set = map[string]bool{}
		s.ownerOf[eventID] = set
	}
	set[owner] = true
}

func (s *Store) removeOwner(eventID, owner string) {
	set := s.ownerOf[eventID]
	if set == nil {
		return
	}
	delete(set, owner)
	if len(set) == 0 {
		delete(s.ownerOf, eventID)
	}
}

// snapshotOrZero 返回实体的当前快照；实体不存在时返回零值快照。
func (s *Store) snapshotOrZero(id string) Snapshot {
	if ent, ok := s.entities[id]; ok {
		return ent.snapshot(s.n)
	}
	return Snapshot{Owner: id}
}

func (s *Store) snapshotsOf(ids []string) map[string]Snapshot {
	out := make(map[string]Snapshot, len(ids))
	for _, id := range ids {
		if _, ok := out[id]; !ok {
			out[id] = s.snapshotOrZero(id)
		}
	}
	return out
}

// emitChanged 对受影响属主比较变更前后快照，输出并记录发生变化的快照。
func (s *Store) emitChanged(affected []string, pre map[string]Snapshot) []Snapshot {
	seen := map[string]bool{}
	var out []Snapshot
	for _, id := range affected {
		if seen[id] {
			continue
		}
		seen[id] = true
		post := s.snapshotOrZero(id)
		if equalSnapshot(pre[id], post) {
			continue
		}
		out = append(out, post)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Owner < out[j].Owner })
	for i := range out {
		s.seq++
		out[i].Seq = s.seq
		s.history = append(s.history, out[i])
	}
	return out
}

func equalSnapshot(a, b Snapshot) bool {
	return a.Count == b.Count && a.Median == b.Median && slices.Equal(a.Window, b.Window)
}

func smallestKey(set map[string]bool) string {
	first := true
	var min string
	for k := range set {
		if first || k < min {
			min = k
			first = false
		}
	}
	return min
}

// entity 一个属主（用户或别名组）的序统计索引。
type entity struct {
	id     string
	events map[string]*Event // ID -> 事件
	order  []*Event          // 全部事件，按 (Time, ID) 升序
	scores []float64         // 窗口（order 末尾 n 项）分数的升序多重集
}

func less(a, b *Event) bool {
	if a.Time != b.Time {
		return a.Time < b.Time
	}
	return a.ID < b.ID
}

// insert 插入事件并维护窗口分数多重集。
func (e *entity) insert(ev *Event, n int) {
	p := sort.Search(len(e.order), func(i int) bool { return !less(e.order[i], ev) })
	e.order = append(e.order, nil)
	copy(e.order[p+1:], e.order[p:])
	e.order[p] = ev
	e.events[ev.ID] = ev
	l := len(e.order)
	switch {
	case l <= n:
		// 窗口即全部事件
		e.addScore(ev.Score)
	case p >= l-n:
		// 新事件进入窗口，原窗口底端元素被挤出
		e.addScore(ev.Score)
		e.removeScore(e.order[l-n-1].Score)
	}
	// 其余情况：新事件位于窗口之下，窗口不变
}

// remove 按 ID 移除事件并维护窗口分数多重集。
func (e *entity) remove(id string, n int) {
	ev, ok := e.events[id]
	if !ok {
		return
	}
	l := len(e.order)
	p := sort.Search(l, func(i int) bool { return !less(e.order[i], ev) })
	switch {
	case l <= n:
		e.removeScore(ev.Score)
	case p >= l-n:
		// 被删事件在窗口内，窗口下方的首个元素补入
		e.removeScore(ev.Score)
		e.addScore(e.order[l-n-1].Score)
	}
	e.order = append(e.order[:p], e.order[p+1:]...)
	delete(e.events, id)
}

func (e *entity) addScore(score float64) {
	i := sort.SearchFloat64s(e.scores, score)
	e.scores = append(e.scores, 0)
	copy(e.scores[i+1:], e.scores[i:])
	e.scores[i] = score
}

func (e *entity) removeScore(score float64) {
	i := sort.SearchFloat64s(e.scores, score)
	if i >= len(e.scores) || e.scores[i] != score {
		panic("stats: 序统计索引不一致")
	}
	e.scores = append(e.scores[:i], e.scores[i+1:]...)
}

func (e *entity) snapshot(n int) Snapshot {
	l := len(e.order)
	start := l - n
	if start < 0 {
		start = 0
	}
	var win []string
	for _, ev := range e.order[start:] {
		win = append(win, ev.ID)
	}
	return Snapshot{
		Owner:  e.id,
		Count:  l - start,
		Median: median(e.scores),
		Window: win,
	}
}

// median 有序分数多重集的中位数；偶数个取中间两项平均。
func median(scores []float64) float64 {
	m := len(scores)
	if m == 0 {
		return 0
	}
	if m%2 == 1 {
		return scores[m/2]
	}
	return (scores[m/2-1] + scores[m/2]) / 2
}
