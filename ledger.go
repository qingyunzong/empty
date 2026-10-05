package ledger

import (
	"fmt"
	"sort"
	"sync"
	"sync/atomic"
)

// Axis 选择累计查询所依据的时间轴。
type Axis int

const (
	AxisBusiness Axis = iota // 业务时间累计
	AxisSubmit               // 提交时间累计
)

func (a Axis) String() string {
	if a == AxisSubmit {
		return "submit"
	}
	return "business"
}

// Snapshot 是某一世代的双索引只读视图。
// 两个索引与各自前缀和在同一次构建中完成，整体原子发布，
// 读者要么看到完整的旧世代，要么看到完整的新世代。
type Snapshot struct {
	Generation uint64

	byBusiness []Entry // 按 (BusinessTime, ID) 升序
	bySubmit   []Entry // 按 (SubmitTime, ID) 升序

	preBusiness []int64 // pre[i] = 前 i 条之和；pre[0] = 0（空前缀为 0）
	preSubmit   []int64
}

// Ledger 是只追加账本：历史前缀永不修改，
// 撤销通过新增冲正批实现。
type Ledger struct {
	mu      sync.Mutex // 串行化写者；读者无锁
	log     []Entry    // 提交顺序的原始日志，故障恢复的唯一事实来源
	ids     map[string]struct{}
	undone  map[string]string // 被冲正条目 ID -> 冲正条目 ID
	batches map[string]int    // 已提交批 ID -> 条目数
	gen     uint64
	snap    atomic.Pointer[Snapshot]
}

// New 创建空账本并发布空快照（空前缀为 0）。
func New() *Ledger {
	l := &Ledger{
		ids:     make(map[string]struct{}),
		undone:  make(map[string]string),
		batches: make(map[string]int),
	}
	l.publishLocked()
	return l
}

// CommitBatch 提交一个已锁结算批：追加日志、重建双索引并原子发布。
func (l *Ledger) CommitBatch(b *Batch) error {
	if !b.Locked {
		return ErrBatchNotLocked
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, dup := l.batches[b.ID]; dup {
		return fmt.Errorf("ledger: batch %s already committed", b.ID)
	}
	for _, e := range b.Entries {
		if _, dup := l.ids[e.ID]; dup {
			return fmt.Errorf("%w: %s", ErrDuplicateID, e.ID)
		}
	}
	for _, e := range b.Entries {
		l.log = append(l.log, e)
		l.ids[e.ID] = struct{}{}
	}
	l.batches[b.ID] = len(b.Entries)
	l.publishLocked()
	return nil
}

// Undo 撤销旧条目：不改动原始前缀，而是新增一个只含冲正条目的
// 已锁结算批并提交。冲正金额为原金额的相反数，继承原条目的
// 业务时间与提交时间，因此两条轴上的累计都会回落，越界点可随之消失。
func (l *Ledger) Undo(id string) (reversalID string, err error) {
	l.mu.Lock()
	var orig *Entry
	for i := range l.log {
		if l.log[i].ID == id {
			orig = &l.log[i]
			break
		}
	}
	if orig == nil {
		l.mu.Unlock()
		return "", fmt.Errorf("ledger: entry %s not found", id)
	}
	if orig.Kind == KindReversal {
		l.mu.Unlock()
		return "", fmt.Errorf("ledger: entry %s is itself a reversal", id)
	}
	if _, done := l.undone[id]; done {
		l.mu.Unlock()
		return "", fmt.Errorf("ledger: entry %s already undone", id)
	}
	reversalID = id + ":rev"
	if _, dup := l.ids[reversalID]; dup {
		reversalID = fmt.Sprintf("%s:rev:%d", id, l.gen)
	}
	rev := Entry{
		ID:           reversalID,
		BusinessTime: orig.BusinessTime,
		SubmitTime:   orig.SubmitTime,
		Amount:       -orig.Amount,
		Kind:         KindReversal,
		ReversesID:   id,
	}
	b := NewBatch("undo-" + reversalID)
	if err := b.Add(rev); err != nil {
		l.mu.Unlock()
		return "", err
	}
	b.Lock()
	l.mu.Unlock()
	if err := l.CommitBatch(b); err != nil {
		return "", err
	}
	l.mu.Lock()
	l.undone[id] = reversalID
	l.mu.Unlock()
	return reversalID, nil
}

// Snapshot 返回当前已发布快照，读取无锁。
func (l *Ledger) Snapshot() *Snapshot { return l.snap.Load() }

// publishLocked 由持锁写者调用：从日志全量重建双索引并原子交换。
func (l *Ledger) publishLocked() {
	l.gen++
	s := buildSnapshot(l.log, l.gen)
	l.snap.Store(s)
}

// buildSnapshot 是唯一的索引构建路径，提交与故障恢复共用，
// 保证两条轴的排序与前缀和语义一致。
func buildSnapshot(log []Entry, gen uint64) *Snapshot {
	byBusiness := append([]Entry(nil), log...)
	bySubmit := append([]Entry(nil), log...)
	sort.SliceStable(byBusiness, func(i, j int) bool {
		a, b := byBusiness[i], byBusiness[j]
		if !a.BusinessTime.Equal(b.BusinessTime) {
			return a.BusinessTime.Before(b.BusinessTime)
		}
		return a.ID < b.ID
	})
	sort.SliceStable(bySubmit, func(i, j int) bool {
		a, b := bySubmit[i], bySubmit[j]
		if !a.SubmitTime.Equal(b.SubmitTime) {
			return a.SubmitTime.Before(b.SubmitTime)
		}
		return a.ID < b.ID
	})
	return &Snapshot{
		Generation:  gen,
		byBusiness:  byBusiness,
		bySubmit:    bySubmit,
		preBusiness: prefixSums(byBusiness),
		preSubmit:   prefixSums(bySubmit),
	}
}

func prefixSums(entries []Entry) []int64 {
	pre := make([]int64, len(entries)+1) // pre[0] = 0：空前缀为 0
	for i, e := range entries {
		pre[i+1] = pre[i] + e.Amount
	}
	return pre
}

func (s *Snapshot) axisData(a Axis) ([]Entry, []int64) {
	if a == AxisSubmit {
		return s.bySubmit, s.preSubmit
	}
	return s.byBusiness, s.preBusiness
}

// Len 返回快照在指定轴上的条目数（两轴相同）。
func (s *Snapshot) Len() int { return len(s.byBusiness) }

// Entries 返回指定轴上有序条目的副本。
func (s *Snapshot) Entries(a Axis) []Entry {
	entries, _ := s.axisData(a)
	return append([]Entry(nil), entries...)
}

// Cumulative 返回指定轴上前 n 条的累计和；n=0 时为空前缀，结果为 0。
func (s *Snapshot) Cumulative(a Axis, n int) int64 {
	_, pre := s.axisData(a)
	if n < 0 {
		n = 0
	}
	if n > len(pre)-1 {
		n = len(pre) - 1
	}
	return pre[n]
}

// FirstExceed 返回指定轴上累计和首次严格超过 budget 的位置
// （1 起始的条目计数）；不存在时返回 -1。
func (s *Snapshot) FirstExceed(a Axis, budget int64) int {
	_, pre := s.axisData(a)
	for i := 1; i < len(pre); i++ {
		if pre[i] > budget {
			return i
		}
	}
	return -1
}

// PrefixEvidence 输出指定轴的完整前缀和证据（含 pre[0]=0）。
func (s *Snapshot) PrefixEvidence(a Axis) []int64 {
	_, pre := s.axisData(a)
	return append([]int64(nil), pre...)
}
