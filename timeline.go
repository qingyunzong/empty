// Package dataeng 解释表接入（table ingestion）的时间线。
//
// 本包是纯内存的时间线重放器：它不打开、不读取、不删除磁盘上的任何数据
// 文件。所有“文件”都只是调用方在事件中点名的字符串标识，清洁（clean）
// 操作也只是在内存里回报哪些名字按规则可以删除。
//
// 瞬间（instant）的生命周期只有三种状态：
//
//	Requested（请求）-> Inflight（在途）-> Completed（完成）
//
// 读取只能看见已完成瞬间的提交。回滚（rollback）让被点名且仍处于在途
// 状态的瞬间失效；已完成的瞬间不受影响。清洁只能处理调用方点名的旧文件，
// 任何仍被某个已完成瞬间引用的文件都会受到保护。
//
// 重放按时间戳排序；时间戳相等时按 完成 > 回滚 > 清洁 > 在途 > 请求 的
// 优先级排序，同优先级保持调用方给定的顺序（稳定排序）。
package dataeng

import "sort"

// State 是一个瞬间所处的生命周期状态。
type State int

const (
	// Requested 表示瞬间已被请求，但尚未进入在途。
	Requested State = iota
	// Inflight 表示瞬间正在执行中。
	Inflight
	// Completed 表示瞬间已经完成并提交，对读取可见。
	Completed
)

// String 返回状态的规范名称。
func (s State) String() string {
	switch s {
	case Requested:
		return "requested"
	case Inflight:
		return "inflight"
	case Completed:
		return "completed"
	default:
		return "unknown"
	}
}

// Kind 表示时间线上的一个事件的类型。
type Kind int

const (
	// KindRequest 是“请求”事件。
	KindRequest Kind = iota
	// KindInflight 是“在途”事件。
	KindInflight
	// KindComplete 是“完成”事件。
	KindComplete
	// KindRollback 是“回滚”事件。
	KindRollback
	// KindClean 是“清洁”事件。
	KindClean
)

// String 返回事件类型的规范名称。
func (k Kind) String() string {
	switch k {
	case KindRequest:
		return "request"
	case KindInflight:
		return "inflight"
	case KindComplete:
		return "complete"
	case KindRollback:
		return "rollback"
	case KindClean:
		return "clean"
	default:
		return "unknown"
	}
}

// rank 是同时间戳下的排序优先级，数值越小越早处理。
// 完成(0) < 回滚(1) < 清洁(2) < 在途(3) < 请求(4)。
func (k Kind) rank() int {
	switch k {
	case KindComplete:
		return 0
	case KindRollback:
		return 1
	case KindClean:
		return 2
	case KindInflight:
		return 3
	case KindRequest:
		return 4
	default:
		return 5
	}
}

// Event 是时间线上的单个事件。
//
// Kind 决定事件类型；InstantID 给出受影响的瞬间标识。Files 在完成事件中
// 表示该提交引用的文件，在清洁事件中表示调用方点名、要求清理的候选旧
// 文件，其它事件忽略 Files。RollbackID 仅在回滚事件中使用，点名要失效的
// 在途瞬间。
type Event struct {
	At         int64
	Kind       Kind
	InstantID  string
	Files      []string
	RollbackID string
}

// NewRequest 构造一个请求事件。
func NewRequest(at int64, id string) Event {
	return Event{At: at, Kind: KindRequest, InstantID: id}
}

// NewInflight 构造一个在途事件。
func NewInflight(at int64, id string) Event {
	return Event{At: at, Kind: KindInflight, InstantID: id}
}

// NewComplete 构造一个完成事件，files 为该提交引用的文件。
func NewComplete(at int64, id string, files []string) Event {
	return Event{At: at, Kind: KindComplete, InstantID: id, Files: files}
}

// NewRollback 构造一个回滚事件，点名让 targetID 这个在途瞬间失效。
func NewRollback(at int64, id, targetID string) Event {
	return Event{At: at, Kind: KindRollback, InstantID: id, RollbackID: targetID}
}

// NewClean 构造一个清洁事件，candidates 为调用方点名的候选旧文件。
func NewClean(at int64, id string, candidates []string) Event {
	return Event{At: at, Kind: KindClean, InstantID: id, Files: candidates}
}

// Instant 是重放后一个瞬间的快照。
type Instant struct {
	ID      string
	State   State
	At      int64
	Files   []string
	Invalid bool
}

// Commit 是一次对读取可见的已完成提交。
type Commit struct {
	ID    string
	At    int64
	Files []string
}

// CleanReport 记录一次清洁事件按规则做出的决策；本包不触碰真实文件。
type CleanReport struct {
	CleanID   string
	At        int64
	Deleted   []string
	Protected []string
}

// View 是时间线重放到某一点后的可见性视图。
type View struct {
	commits   []Commit
	completed map[string]Commit
	inflight  map[string]Instant
	requested map[string]Instant
	invalid   map[string]Instant
	cleans    []CleanReport
}

// TracePoint 记录重放处理单个事件之后被影响瞬间的状态，用于逐步核对。
type TracePoint struct {
	Index   int
	Event   Event
	Instant Instant
	Found   bool
}

// Timeline 保存待解释的事件序列。它本身是数据容器，Replay 不会修改
// Timeline，也不会触碰文件系统。
type Timeline struct {
	events []Event
}

// NewTimeline 用给定事件构造时间线。事件会被复制一份，避免外部切片被
// 后续修改而影响重放。
func NewTimeline(events []Event) *Timeline {
	copied := make([]Event, len(events))
	copy(copied, events)
	return &Timeline{events: copied}
}

// orderedEvents 返回按规则排序后的事件副本：先按时间戳，再按同时间戳
// 优先级，同优先级保持原始顺序（稳定排序）。
func (t *Timeline) orderedEvents() []Event {
	ordered := make([]Event, len(t.events))
	copy(ordered, t.events)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].At != ordered[j].At {
			return ordered[i].At < ordered[j].At
		}
		return ordered[i].Kind.rank() < ordered[j].Kind.rank()
	})
	return ordered
}

type engine struct {
	commits   []Commit
	completed map[string]Commit
	inflight  map[string]Instant
	requested map[string]Instant
	invalid   map[string]Instant
	cleans    []CleanReport
}

func newEngine() *engine {
	return &engine{
		completed: map[string]Commit{},
		inflight:  map[string]Instant{},
		requested: map[string]Instant{},
		invalid:   map[string]Instant{},
	}
}

func copyStrings(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	out := make([]string, len(in))
	copy(out, in)
	return out
}

func (e *engine) snapshotInstant(id string) (Instant, bool) {
	if c, ok := e.completed[id]; ok {
		return Instant{ID: c.ID, State: Completed, At: c.At, Files: copyStrings(c.Files)}, true
	}
	if ins, ok := e.inflight[id]; ok {
		return ins, true
	}
	if ins, ok := e.requested[id]; ok {
		return ins, true
	}
	if ins, ok := e.invalid[id]; ok {
		return ins, true
	}
	return Instant{}, false
}

func (e *engine) apply(ev Event) {
	switch ev.Kind {
	case KindRequest:
		if _, known := e.snapshotInstant(ev.InstantID); known {
			return
		}
		e.requested[ev.InstantID] = Instant{
			ID:    ev.InstantID,
			State: Requested,
			At:    ev.At,
			Files: []string{},
		}
	case KindInflight:
		// 只允许 请求 -> 在途 的迁移；未知或已推进的瞬间忽略。
		ins, ok := e.requested[ev.InstantID]
		if !ok {
			return
		}
		delete(e.requested, ev.InstantID)
		ins.State = Inflight
		e.inflight[ev.InstantID] = ins
	case KindComplete:
		// 只有在途瞬间可以完成；请求态、未知瞬间的完成事件被忽略。
		ins, ok := e.inflight[ev.InstantID]
		if !ok {
			return
		}
		delete(e.inflight, ev.InstantID)
		files := copyStrings(ev.Files)
		ins.State = Completed
		ins.Files = files
		commit := Commit{ID: ev.InstantID, At: ev.At, Files: files}
		e.completed[ev.InstantID] = commit
		e.commits = append(e.commits, commit)
	case KindRollback:
		// 只让被点名的“在途”瞬间失效；已完成、请求中或未知都不受影响。
		ins, ok := e.inflight[ev.RollbackID]
		if !ok {
			return
		}
		delete(e.inflight, ev.RollbackID)
		ins.Invalid = true
		e.invalid[ev.RollbackID] = ins
	case KindClean:
		protectedSet := map[string]bool{}
		for _, commit := range e.commits {
			for _, name := range commit.Files {
				protectedSet[name] = true
			}
		}
		report := CleanReport{
			CleanID:   ev.InstantID,
			At:        ev.At,
			Deleted:   []string{},
			Protected: []string{},
		}
		seenDeleted := map[string]bool{}
		seenProtected := map[string]bool{}
		for _, name := range ev.Files {
			if protectedSet[name] {
				if !seenProtected[name] {
					report.Protected = append(report.Protected, name)
					seenProtected[name] = true
				}
				continue
			}
			if !seenDeleted[name] {
				report.Deleted = append(report.Deleted, name)
				seenDeleted[name] = true
			}
		}
		e.cleans = append(e.cleans, report)
	}
}

func (e *engine) view() *View {
	return &View{
		commits:   cloneCommits(e.commits),
		completed: cloneCompleted(e.completed),
		inflight:  cloneInstants(e.inflight),
		requested: cloneInstants(e.requested),
		invalid:   cloneInstants(e.invalid),
		cleans:    cloneCleans(e.cleans),
	}
}

func cloneCommits(in []Commit) []Commit {
	out := make([]Commit, len(in))
	for i, commit := range in {
		out[i] = Commit{ID: commit.ID, At: commit.At, Files: copyStrings(commit.Files)}
	}
	return out
}

func cloneCompleted(in map[string]Commit) map[string]Commit {
	out := make(map[string]Commit, len(in))
	for id, commit := range in {
		out[id] = Commit{ID: commit.ID, At: commit.At, Files: copyStrings(commit.Files)}
	}
	return out
}

func cloneInstants(in map[string]Instant) map[string]Instant {
	out := make(map[string]Instant, len(in))
	for id, ins := range in {
		ins.Files = copyStrings(ins.Files)
		out[id] = ins
	}
	return out
}

func cloneCleans(in []CleanReport) []CleanReport {
	out := make([]CleanReport, len(in))
	for i, report := range in {
		out[i] = CleanReport{
			CleanID:   report.CleanID,
			At:        report.At,
			Deleted:   copyStrings(report.Deleted),
			Protected: copyStrings(report.Protected),
		}
	}
	return out
}

// Replay 按时间线规则重放全部事件，返回最终视图与逐步追踪。它不修改
// Timeline，也不执行任何文件系统操作。
func (t *Timeline) Replay() (*View, []TracePoint) {
	ordered := t.orderedEvents()
	eng := newEngine()
	trace := make([]TracePoint, 0, len(ordered))
	for i, ev := range ordered {
		eng.apply(ev)
		targetID := ev.InstantID
		if ev.Kind == KindRollback {
			targetID = ev.RollbackID
		}
		ins, found := eng.snapshotInstant(targetID)
		trace = append(trace, TracePoint{Index: i, Event: ev, Instant: ins, Found: found})
	}
	return eng.view(), trace
}

// ReplayUntil 重放时间戳不超过 at 的事件（含同时间戳并按优先级排序后的
// 全部事件），返回该时刻的视图。
func (t *Timeline) ReplayUntil(at int64) *View {
	eng := newEngine()
	for _, ev := range t.orderedEvents() {
		if ev.At > at {
			break
		}
		eng.apply(ev)
	}
	return eng.view()
}

// Commits 按完成先后返回所有对读取可见的提交。
func (v *View) Commits() []Commit {
	return cloneCommits(v.commits)
}

// VisibleFiles 返回所有已完成提交引用文件的去重并集，即读取能看见的文件。
func (v *View) VisibleFiles() []string {
	seen := map[string]bool{}
	var out []string
	for _, commit := range v.commits {
		for _, name := range commit.Files {
			if !seen[name] {
				seen[name] = true
				out = append(out, name)
			}
		}
	}
	return out
}

// IsVisible 报告某个文件是否仍被任一已完成瞬间引用。
func (v *View) IsVisible(file string) bool {
	for _, commit := range v.commits {
		for _, name := range commit.Files {
			if name == file {
				return true
			}
		}
	}
	return false
}

// State 返回瞬间的状态；found 为 false 表示该瞬间从未出现。被回滚失效的
// 瞬间仍可查询，其 invalid 为 true，state 保留失效前的状态（在途）。
func (v *View) State(id string) (state State, invalid bool, found bool) {
	if _, ok := v.completed[id]; ok {
		return Completed, false, true
	}
	if ins, ok := v.inflight[id]; ok {
		return ins.State, false, true
	}
	if ins, ok := v.requested[id]; ok {
		return ins.State, false, true
	}
	if ins, ok := v.invalid[id]; ok {
		return ins.State, true, true
	}
	return 0, false, false
}

// InvalidIDs 返回所有被回滚失效的瞬间标识，按字典序排列。
func (v *View) InvalidIDs() []string {
	out := make([]string, 0, len(v.invalid))
	for id := range v.invalid {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// InflightIDs 返回重放结束时仍处于在途状态的瞬间标识，按字典序排列。
func (v *View) InflightIDs() []string {
	out := make([]string, 0, len(v.inflight))
	for id := range v.inflight {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// RequestedIDs 返回重放结束时仍处于请求状态的瞬间标识，按字典序排列。
func (v *View) RequestedIDs() []string {
	out := make([]string, 0, len(v.requested))
	for id := range v.requested {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// CleanReports 返回每次清洁事件的决策记录（按处理顺序）。
func (v *View) CleanReports() []CleanReport {
	return cloneCleans(v.cleans)
}
