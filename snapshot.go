package dataeng

import (
	"errors"
	"math/big"
	"sort"
)

// OpKind 标识批次中一条记录操作的类型。
type OpKind int

const (
	// OpInsert 插入一条新记录，同组内 ID 必须不存在。
	OpInsert OpKind = iota + 1
	// OpReplace 替换既有记录的可空值，同组内 ID 必须已存在。
	OpReplace
	// OpDelete 删除既有记录，同组内 ID 必须已存在。
	OpDelete
)

// Record 是带唯一 ID 的可空整数记录。Value 为 nil 表示空值。
type Record struct {
	ID    string
	Value *int64
}

// Op 是批次中的一条原子记录操作，Group 为字符串组键。
// Delete 只使用 Record.ID；Insert 与 Replace 使用 ID 及可空 Value。
type Op struct {
	Kind   OpKind
	Group  string
	Record Record
}

// 批次中任何一条操作非法时，整批回滚并返回可被 errors.Is 识别的错误。
var (
	// ErrUnknownOp 表示操作类型不在 OpInsert/OpReplace/OpDelete 之内。
	ErrUnknownOp = errors.New("dataeng: unknown op kind")
	// ErrEmptyID 表示记录 ID 为空字符串。
	ErrEmptyID = errors.New("dataeng: record id must not be empty")
	// ErrIDExists 表示 Insert 的 ID 在目标组中已存在。
	ErrIDExists = errors.New("dataeng: record id already exists")
	// ErrIDMissing 表示 Replace 或 Delete 的 ID 在目标组中不存在。
	ErrIDMissing = errors.New("dataeng: record id does not exist")
)

// Fraction 表示已约分的有理数 numerator/denominator，分母恒为正数。
type Fraction struct {
	numerator   *big.Int
	denominator *big.Int
}

// Numerator 返回分子的独立副本，调用方可任意修改而不影响该分数。
func (f Fraction) Numerator() *big.Int {
	return new(big.Int).Set(f.numerator)
}

// Denominator 返回分母的独立副本；分母始终为正数。
func (f Fraction) Denominator() *big.Int {
	return new(big.Int).Set(f.denominator)
}

// String 以 "numerator/denominator" 的形式输出最简分数。
func (f Fraction) String() string {
	return f.numerator.String() + "/" + f.denominator.String()
}

// Stats 是单个组在某个版本上的聚合结果。指针字段为 nil 表示 null。
type Stats struct {
	// Count 是组内记录条数，包含空值记录。
	Count int64
	// NonNull 是非空记录条数。
	NonNull int64
	// Sum 是非空值之和（任意精度）；无任何非空值时为 nil。
	Sum *big.Int
	// Min 是非空值中的最小值；无任何非空值时为 nil。
	Min *int64
	// Max 是非空值中的最大值；无任何非空值时为 nil。
	Max *int64
	// Avg 是 Sum/NonNull 的最简分数；无任何非空值时为 nil。
	Avg *Fraction
}

// groupState 是单个组的内部可变状态，仅在构建新版本快照期间存活。
type groupState struct {
	values map[string]*int64 // ID -> 可空值（nil 表示空值记录）
	sum    *big.Int          // 非空值之和，恒非 nil
	min    *int64            // 非空值最小值，可能为 nil
	max    *int64            // 非空值最大值，可能为 nil
}

func newGroupState() *groupState {
	return &groupState{
		values: make(map[string]*int64),
		sum:    new(big.Int),
	}
}

// clone 深拷贝组状态，保证旧快照不会被新版本的构建过程修改。
func (g *groupState) clone() *groupState {
	copied := &groupState{
		values: make(map[string]*int64, len(g.values)),
		sum:    new(big.Int).Set(g.sum),
		min:    cloneInt64(g.min),
		max:    cloneInt64(g.max),
	}
	for id, value := range g.values {
		copied.values[id] = cloneInt64(value)
	}
	return copied
}

func (g *groupState) addValue(value *int64) {
	if value == nil {
		return
	}
	g.sum.Add(g.sum, big.NewInt(*value))
	if g.min == nil || *value < *g.min {
		g.min = cloneInt64(value)
	}
	if g.max == nil || *value > *g.max {
		g.max = cloneInt64(value)
	}
}

func (g *groupState) removeValue(value *int64) {
	if value == nil {
		return
	}
	g.sum.Sub(g.sum, big.NewInt(*value))
	// 仅当被删值等于当前极值时才可能改变极值；记录与极值缓存是独立指针，
	// 此处的 value 仍保留删除前的值，可安全按值比较后基于现存记录重算。
	if (g.min != nil && *value == *g.min) || (g.max != nil && *value == *g.max) {
		g.recomputeExtremes()
	}
}

// recomputeExtremes 在被删除的值可能是极值时全量重算 min/max。
func (g *groupState) recomputeExtremes() {
	g.min = nil
	g.max = nil
	for _, value := range g.values {
		if value == nil {
			continue
		}
		if g.min == nil || *value < *g.min {
			g.min = cloneInt64(value)
		}
		if g.max == nil || *value > *g.max {
			g.max = cloneInt64(value)
		}
	}
}

// stats 由当前组状态计算对外的不可变聚合结果。
func (g *groupState) stats() Stats {
	result := Stats{
		Count: int64(len(g.values)),
		Sum:   new(big.Int).Set(g.sum),
		Min:   cloneInt64(g.min),
		Max:   cloneInt64(g.max),
	}
	for _, value := range g.values {
		if value != nil {
			result.NonNull++
		}
	}
	if result.NonNull == 0 {
		// 全空组：除计数外全部为 null。
		result.Sum = nil
		return result
	}
	num := new(big.Int).Set(g.sum)
	den := big.NewInt(result.NonNull)
	gcd := new(big.Int).GCD(nil, nil, new(big.Int).Abs(num), den)
	result.Avg = &Fraction{
		numerator:   new(big.Int).Quo(num, gcd),
		denominator: new(big.Int).Quo(big.NewInt(result.NonNull), gcd),
	}
	return result
}

// Snapshot 是某一版本上不可变的分组聚合状态。
// 快照一旦由 Apply 返回即不再变化，读者可长期保留任意旧版本。
type Snapshot struct {
	seq    int64
	groups map[string]*groupState
}

// Version 返回快照的单调版本号，初始快照为 0。
func (s *Snapshot) Version() int64 {
	return s.seq
}

// GroupKeys 返回快照中所有非空组键的有序副本。
func (s *Snapshot) GroupKeys() []string {
	keys := make([]string, 0, len(s.groups))
	for key := range s.groups {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Count 返回组内记录条数；组不存在时返回 0。
func (s *Snapshot) Count(group string) int64 {
	state, ok := s.groups[group]
	if !ok {
		return 0
	}
	return int64(len(state.values))
}

// Stats 返回组的聚合结果副本。组不存在（空组已被移除）时 ok 为 false。
// 返回的 big.Int、int64 指针均为独立副本，调用方修改不会影响快照。
func (s *Snapshot) Stats(group string) (Stats, bool) {
	state, ok := s.groups[group]
	if !ok {
		return Stats{}, false
	}
	return state.stats(), true
}

// Apply 在当前快照之上应用一个操作批次，返回新版本快照。
// 批次中任何一条操作非法都会导致整批回滚：返回错误并保持接收者不变。
// 空批次返回版本号加一、内容相同的新快照。
func (s *Snapshot) Apply(ops []Op) (*Snapshot, error) {
	next := &Snapshot{
		seq:    s.seq + 1,
		groups: make(map[string]*groupState, len(s.groups)),
	}
	for key, state := range s.groups {
		next.groups[key] = state.clone()
	}
	for index, op := range ops {
		if err := next.applyOp(op); err != nil {
			return nil, &BatchError{Index: index, Op: op, Err: err}
		}
	}
	return next, nil
}

func (s *Snapshot) applyOp(op Op) error {
	switch op.Kind {
	case OpInsert, OpReplace, OpDelete:
	default:
		return ErrUnknownOp
	}
	if op.Record.ID == "" {
		return ErrEmptyID
	}
	state, groupExists := s.groups[op.Group]
	if !groupExists {
		if op.Kind != OpInsert {
			return ErrIDMissing
		}
		state = newGroupState()
		s.groups[op.Group] = state
	}
	_, exists := state.values[op.Record.ID]
	switch op.Kind {
	case OpInsert:
		if exists {
			return ErrIDExists
		}
		inserted := cloneInt64(op.Record.Value)
		state.values[op.Record.ID] = inserted
		state.addValue(inserted)
	case OpReplace:
		if !exists {
			return ErrIDMissing
		}
		// 先以独立指针覆盖记录，再用保存的旧值剔除其聚合贡献，
		// 保证极值重算看到的是替换后的现存记录集合。
		oldValue := state.values[op.Record.ID]
		newValue := cloneInt64(op.Record.Value)
		state.values[op.Record.ID] = newValue
		state.removeValue(oldValue)
		state.addValue(newValue)
	case OpDelete:
		if !exists {
			return ErrIDMissing
		}
		removed := state.values[op.Record.ID]
		delete(state.values, op.Record.ID)
		// 先从记录集合移除，再按保存的旧值维护聚合，
		// 保证极值重算不会把已删除记录算回去。
		state.removeValue(removed)
		if len(state.values) == 0 {
			// 空组从结果中移除。
			delete(s.groups, op.Group)
		}
	}
	return nil
}

// BatchError 标注批次中第一条非法操作的位置与原因，可通过 errors.Is/As 还原哨兵错误。
type BatchError struct {
	Index int
	Op    Op
	Err   error
}

func (e *BatchError) Error() string {
	return e.Err.Error()
}

func (e *BatchError) Unwrap() error {
	return e.Err
}

func cloneInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}
