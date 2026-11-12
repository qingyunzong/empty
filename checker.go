package dataeng

import (
	"fmt"
	"sync"
)

// ParentRecord 是一条父实体记录：实体键 Key 与半开有效期 Valid。
// RecordID 在所有父记录中唯一。同一 Key 的多条记录区间允许重叠或相接。
type ParentRecord[K comparable, ID comparable] struct {
	RecordID ID
	Key      K
	Valid    Interval
}

// ChildRecord 是一条子记录：Ref 引用父实体键，Valid 为自身半开有效期。
// RecordID 在所有子记录中唯一。Ref 为 nil 表示空引用，免检。
type ChildRecord[K comparable, ID comparable] struct {
	RecordID ID
	Ref      *K
	Valid    Interval
}

// ChildGapChange 描述删除父记录后单个受影响子记录的净缺口变化。
type ChildGapChange[ID comparable] struct {
	ChildID ID
	// Before 是删除前该子记录未被覆盖的最大不相交区间。
	Before []Interval
	// After 是删除后该子记录未被覆盖的最大不相交区间。
	After []Interval
	// NetNew 是净新增缺口（After 减去 Before），仅包含真正变化的部分。
	NetNew []Interval
}

// DeletionReport 是删除父记录的影响报告，仅列出净缺口发生变化的子记录。
type DeletionReport[IDP comparable, IDC comparable] struct {
	// DeletedParentIDs 为本批实际删除的父记录 ID。
	DeletedParentIDs []IDP
	// Affected 按子记录插入顺序列出净缺口发生变化的子记录。
	Affected []ChildGapChange[IDC]
}

// Checker 是时间外键校验器，并发安全。
// K 为实体键类型，IDP 为父记录 ID 类型，IDC 为子记录 ID 类型。
type Checker[K comparable, IDP comparable, IDC comparable] struct {
	mu sync.RWMutex

	parents   map[IDP]ParentRecord[K, IDP]
	parentIDs []IDP

	children   map[IDC]ChildRecord[K, IDC]
	childIDs   []IDC
	childOrder map[IDC]int

	nextChildOrder int
}

// New 创建空的时间外键校验器。
func New[K comparable, IDP comparable, IDC comparable]() *Checker[K, IDP, IDC] {
	return &Checker[K, IDP, IDC]{
		parents:    make(map[IDP]ParentRecord[K, IDP]),
		children:   make(map[IDC]ChildRecord[K, IDC]),
		childOrder: make(map[IDC]int),
	}
}

// AddParents 原子批量新增父记录。
// 任一条记录区间反向、批内 ID 重复或 ID 已存在，整批拒绝、状态不变。
func (c *Checker[K, IDP, IDC]) AddParents(recs []ParentRecord[K, IDP]) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	seen := make(map[IDP]struct{}, len(recs))
	var badInterval, dup []IDP
	for _, r := range recs {
		if !r.Valid.valid() {
			badInterval = append(badInterval, r.RecordID)
			continue
		}
		if _, ok := seen[r.RecordID]; ok {
			dup = append(dup, r.RecordID)
			continue
		}
		if _, ok := c.parents[r.RecordID]; ok {
			dup = append(dup, r.RecordID)
			continue
		}
		seen[r.RecordID] = struct{}{}
	}
	if len(badInterval) > 0 {
		return &BatchError{Kind: KindReverseInterval, IDs: toStrings(badInterval), Op: "add-parents"}
	}
	if len(dup) > 0 {
		return &BatchError{Kind: KindDuplicateID, IDs: toStrings(dup), Op: "add-parents"}
	}
	for _, r := range recs {
		c.parents[r.RecordID] = r
		c.parentIDs = append(c.parentIDs, r.RecordID)
	}
	return nil
}

// AddChildren 原子批量新增子记录。
// 任一条记录区间反向、批内 ID 重复或 ID 已存在，整批拒绝、状态不变。
// 允许引用当前尚无父记录的键，其有效期整体表现为缺口。
func (c *Checker[K, IDP, IDC]) AddChildren(recs []ChildRecord[K, IDC]) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	seen := make(map[IDC]struct{}, len(recs))
	var badInterval, dup []IDC
	for _, r := range recs {
		if !r.Valid.valid() {
			badInterval = append(badInterval, r.RecordID)
			continue
		}
		if _, ok := seen[r.RecordID]; ok {
			dup = append(dup, r.RecordID)
			continue
		}
		if _, ok := c.children[r.RecordID]; ok {
			dup = append(dup, r.RecordID)
			continue
		}
		seen[r.RecordID] = struct{}{}
	}
	if len(badInterval) > 0 {
		return &BatchError{Kind: KindReverseInterval, IDs: toStrings(badInterval), Op: "add-children"}
	}
	if len(dup) > 0 {
		return &BatchError{Kind: KindDuplicateID, IDs: toStrings(dup), Op: "add-children"}
	}
	for _, r := range recs {
		c.children[r.RecordID] = r
		c.childIDs = append(c.childIDs, r.RecordID)
		c.childOrder[r.RecordID] = c.nextChildOrder
		c.nextChildOrder++
	}
	return nil
}

// DeleteChildren 原子批量删除子记录。任一 ID 缺失则整批拒绝、状态不变。
func (c *Checker[K, IDP, IDC]) DeleteChildren(ids []IDC) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	seen := make(map[IDC]struct{}, len(ids))
	var missing, dup []IDC
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			dup = append(dup, id)
			continue
		}
		seen[id] = struct{}{}
		if _, ok := c.children[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(dup) > 0 {
		return &BatchError{Kind: KindDuplicateID, IDs: toStrings(dup), Op: "delete-children"}
	}
	if len(missing) > 0 {
		return &BatchError{Kind: KindMissingID, IDs: toStrings(missing), Op: "delete-children"}
	}
	for _, id := range ids {
		delete(c.children, id)
		delete(c.childOrder, id)
	}
	c.childIDs = c.childIDs[:0]
	for id := range c.children {
		c.childIDs = append(c.childIDs, id)
	}
	sortByOrder(c.childIDs, c.childOrder)
	return nil
}

// DeleteParents 原子批量删除父记录并返回净缺口变化报告。
// 任一 ID 缺失（含批内重复导致的歧义）则整批拒绝、状态不变。
// 报告仅包含删除后缺口确实发生变化的子记录，按子记录插入顺序排列。
func (c *Checker[K, IDP, IDC]) DeleteParents(ids []IDP) (*DeletionReport[IDP, IDC], error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	seen := make(map[IDP]struct{}, len(ids))
	var missing, dup []IDP
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			dup = append(dup, id)
			continue
		}
		seen[id] = struct{}{}
		if _, ok := c.parents[id]; !ok {
			missing = append(missing, id)
		}
	}
	if len(dup) > 0 {
		return nil, &BatchError{Kind: KindDuplicateID, IDs: toStrings(dup), Op: "delete-parents"}
	}
	if len(missing) > 0 {
		return nil, &BatchError{Kind: KindMissingID, IDs: toStrings(missing), Op: "delete-parents"}
	}

	type snapshot struct {
		child ChildRecord[K, IDC]
		gaps  []Interval
	}
	snaps := make([]snapshot, 0, len(c.childIDs))
	for _, id := range c.childIDs {
		ch := c.children[id]
		snaps = append(snaps, snapshot{child: ch, gaps: c.gapsLocked(ch)})
	}

	for _, id := range ids {
		delete(c.parents, id)
	}
	c.parentIDs = c.parentIDs[:0]
	for id := range c.parents {
		c.parentIDs = append(c.parentIDs, id)
	}

	report := &DeletionReport[IDP, IDC]{DeletedParentIDs: append([]IDP(nil), ids...)}
	for _, snap := range snaps {
		after := c.gapsLocked(snap.child)
		if intervalsEqual(snap.gaps, after) {
			continue
		}
		report.Affected = append(report.Affected, ChildGapChange[IDC]{
			ChildID: snap.child.RecordID,
			Before:  cloneIntervals(snap.gaps),
			After:   cloneIntervals(after),
			NetNew:  diffIntervals(after, snap.gaps),
		})
	}
	return report, nil
}

// Gaps 返回指定子记录未被父记录覆盖的最大不相交区间（按起点升序）。
// 空引用子记录免检，返回 nil；空有效期同样返回 nil。
// 子记录不存在时返回 ErrChildNotFound。
func (c *Checker[K, IDP, IDC]) Gaps(childID IDC) ([]Interval, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	ch, ok := c.children[childID]
	if !ok {
		return nil, fmt.Errorf("%w: %v", ErrChildNotFound, childID)
	}
	return c.gapsLocked(ch), nil
}

// AllGaps 返回全部子记录的缺口，键为子记录 ID，按子记录插入顺序排列。
// 空引用或空有效期的子记录缺口为 nil。
func (c *Checker[K, IDP, IDC]) AllGaps() map[IDC][]Interval {
	c.mu.RLock()
	defer c.mu.RUnlock()

	out := make(map[IDC][]Interval, len(c.childIDs))
	for _, id := range c.childIDs {
		out[id] = c.gapsLocked(c.children[id])
	}
	return out
}

// gapsLocked 计算单子记录缺口：空引用免检，其余按键取父区间并集后求差。
func (c *Checker[K, IDP, IDC]) gapsLocked(ch ChildRecord[K, IDC]) []Interval {
	if ch.Ref == nil || ch.Valid.empty() {
		return nil
	}
	covered := c.coveredLocked(*ch.Ref)
	return sweepGaps(ch.Valid, covered)
}

// coveredLocked 返回某实体键下全部父记录有效期的并集。
func (c *Checker[K, IDP, IDC]) coveredLocked(key K) []Interval {
	ivs := make([]Interval, 0)
	for _, pid := range c.parentIDs {
		if p := c.parents[pid]; p.Key == key {
			ivs = append(ivs, p.Valid)
		}
	}
	return unionIntervals(ivs)
}

// Verify 以端点离散化对全部子记录做全比较核验：
// 扫描线算法与离散化算法结果必须一致；缺口与父覆盖并集必须恰好拼成子区间；
// 同时对 int64 极值探针核验联合覆盖与极值判定。
func (c *Checker[K, IDP, IDC]) Verify() error {
	c.mu.RLock()
	defer c.mu.RUnlock()

	for _, id := range c.childIDs {
		ch := c.children[id]
		if ch.Ref == nil {
			if got := c.gapsLocked(ch); got != nil {
				return fmt.Errorf("dataeng: verify: null-ref child %v has gaps", id)
			}
			continue
		}
		covered := c.coveredLocked(*ch.Ref)
		sweep := sweepGaps(ch.Valid, covered)
		disc := discreteGaps(ch.Valid, covered)
		if !intervalsEqual(sweep, disc) {
			return fmt.Errorf("dataeng: verify: child %v algorithm mismatch %v != %v", id, sweep, disc)
		}
		// 联合覆盖：先将父覆盖裁剪到子区间，再与缺口拼接，必须恰好等于子区间。
		clipped := clipIntervals(covered, ch.Valid)
		if union := unionIntervals(append(clipped, sweep...)); !coversExactly(union, ch.Valid) {
			return fmt.Errorf("dataeng: verify: child %v union coverage does not equal validity", id)
		}
		if err := verifyExtrema(ch.Valid, covered, sweep); err != nil {
			return fmt.Errorf("dataeng: verify: child %v: %w", id, err)
		}
	}
	if err := verifyExtremaProbes(); err != nil {
		return err
	}
	return nil
}

// coversExactly 报告已合并区间集合是否恰好等于单个目标区间。
func coversExactly(union []Interval, target Interval) bool {
	if target.empty() {
		return len(union) == 0
	}
	if len(union) != 1 {
		return false
	}
	return union[0] == target
}

// clipIntervals 将区间集合裁剪到 target 范围内（全部为半开区间，无中点运算）。
func clipIntervals(in []Interval, target Interval) []Interval {
	out := make([]Interval, 0, len(in))
	for _, iv := range in {
		lo, hi := iv.Start, iv.End
		if lo < target.Start {
			lo = target.Start
		}
		if hi > target.End {
			hi = target.End
		}
		if lo < hi {
			out = append(out, Interval{lo, hi})
		}
	}
	return unionIntervals(out)
}

func cloneIntervals(in []Interval) []Interval {
	if len(in) == 0 {
		return nil
	}
	out := make([]Interval, len(in))
	copy(out, in)
	return out
}
