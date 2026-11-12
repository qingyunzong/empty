package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"sort"
)

// Variable 是一个有唯一 ASCII ID 的有限域变量，Domain 按给定次序排列。
type Variable struct {
	ID     string
	Domain []string
}

// Entry 是因子稀疏赋值表中的一行，Assignment 与 Factor.Scope 按位置对齐。
// 未列出的赋值组合势值精确为 0。
type Entry struct {
	Assignment []string
	Value      *big.Rat
}

// Factor 是一个非负有理势因子，Scope 有序且不重复，允许空 scope 表示标量。
type Factor struct {
	Scope   []string
	Entries []Entry
}

// Model 是已校验、不可变的有限域因子模型。
type Model struct {
	vars    []Variable
	domSize []int
	index   map[string]int
	domVal  []map[string]int
	factors []*ifactor
}

// NewModel 校验并构造模型。输入切片与有理数会被复制，后续修改不影响模型。
func NewModel(variables []Variable, factors []Factor) (*Model, error) {
	if len(variables) == 0 {
		return nil, errors.New("dataeng: at least one variable is required")
	}
	if len(variables) > 40 {
		return nil, errors.New("dataeng: at most 40 variables are allowed")
	}

	m := &Model{
		vars:   make([]Variable, len(variables)),
		index:  make(map[string]int, len(variables)),
		domVal: make([]map[string]int, len(variables)),
	}

	for i, v := range variables {
		if v.ID == "" {
			return nil, errors.New("dataeng: variable id must be non-empty")
		}
		for _, b := range []byte(v.ID) {
			if b >= 0x80 {
				return nil, fmt.Errorf("dataeng: variable id %q is not ASCII", v.ID)
			}
		}
		if _, dup := m.index[v.ID]; dup {
			return nil, fmt.Errorf("dataeng: duplicate variable id %q", v.ID)
		}
		if len(v.Domain) < 1 || len(v.Domain) > 16 {
			return nil, fmt.Errorf("dataeng: variable %q domain size must be in 1..16", v.ID)
		}
		domain := make([]string, len(v.Domain))
		copy(domain, v.Domain)
		values := make(map[string]int, len(domain))
		for j, d := range domain {
			if _, dup := values[d]; dup {
				return nil, fmt.Errorf("dataeng: variable %q has duplicate domain value %q", v.ID, d)
			}
			values[d] = j
		}
		m.index[v.ID] = i
		m.vars[i] = Variable{ID: v.ID, Domain: domain}
		m.domSize = append(m.domSize, len(domain))
		m.domVal[i] = values
	}

	for fi, f := range factors {
		iff, err := m.buildFactor(fi, f)
		if err != nil {
			return nil, err
		}
		m.factors = append(m.factors, iff)
	}
	return m, nil
}

func (m *Model) buildFactor(fi int, f Factor) (*ifactor, error) {
	scope := make([]int, 0, len(f.Scope))
	seen := make(map[int]bool, len(f.Scope))
	for _, id := range f.Scope {
		idx, ok := m.index[id]
		if !ok {
			return nil, fmt.Errorf("dataeng: factor %d references unknown variable %q", fi, id)
		}
		if seen[idx] {
			return nil, fmt.Errorf("dataeng: factor %d has repeated variable %q in scope", fi, id)
		}
		seen[idx] = true
		scope = append(scope, idx)
	}

	// 内部统一按模型次序保存 scope，输入因子自身的轴序仅用于对齐赋值行。
	canonical := append([]int(nil), scope...)
	sort.Ints(canonical)
	table := make(map[string]*big.Rat)
	tuples := make(map[string]bool)

	for ei, e := range f.Entries {
		if len(e.Assignment) != len(f.Scope) {
			return nil, fmt.Errorf("dataeng: factor %d entry %d assignment length does not match scope", fi, ei)
		}
		if e.Value == nil {
			return nil, fmt.Errorf("dataeng: factor %d entry %d has nil value", fi, ei)
		}
		if e.Value.Sign() < 0 {
			return nil, fmt.Errorf("dataeng: factor %d entry %d has negative value", fi, ei)
		}
		key := make([]byte, len(canonical))
		for si, id := range f.Scope {
			vIdx := m.index[id]
			dIdx, ok := m.domVal[vIdx][e.Assignment[si]]
			if !ok {
				return nil, fmt.Errorf("dataeng: factor %d entry %d uses out-of-domain value %q for %q", fi, ei, e.Assignment[si], id)
			}
			pos := sort.SearchInts(canonical, vIdx)
			key[pos] = byte(dIdx)
		}
		skey := string(key)
		if tuples[skey] {
			return nil, fmt.Errorf("dataeng: factor %d has duplicate assignment at entry %d", fi, ei)
		}
		tuples[skey] = true
		if e.Value.Sign() == 0 {
			continue // 显式零与缺省等价，稀疏表中不保留
		}
		table[skey] = new(big.Rat).Set(e.Value)
	}
	return &ifactor{scope: canonical, table: table}, nil
}

// VariableCount 返回模型变量数。
func (m *Model) VariableCount() int { return len(m.vars) }

// FactorCount 返回模型因子数。
func (m *Model) FactorCount() int { return len(m.factors) }

// Variable 按 ID 查询变量副本。
func (m *Model) Variable(id string) (Variable, bool) {
	idx, ok := m.index[id]
	if !ok {
		return Variable{}, false
	}
	v := m.vars[idx]
	domain := append([]string(nil), v.Domain...)
	return Variable{ID: v.ID, Domain: domain}, true
}
