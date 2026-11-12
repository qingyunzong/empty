package dataeng

import (
	"math/big"
	"sort"
)

// ifactor 是内部因子：scope 为按模型次序排列的变量下标，table 的键是
// 与 scope 对齐的域下标元组（每字节一个域下标），仅保存非零项。
type ifactor struct {
	scope []int
	table map[string]*big.Rat
}

func (f *ifactor) scopeIDs(m *Model) []string {
	ids := make([]string, 0, len(f.scope))
	for _, idx := range f.scope {
		ids = append(ids, m.vars[idx].ID)
	}
	return ids
}

// restrict 将证据代入因子：证据变量被固定，冲突赋值的表项整体丢弃，
// 其余表项去掉证据轴。始终返回新因子，不修改原因子。
func (m *Model) restrict(f *ifactor, evidence map[string]int) *ifactor {
	kept := make([]int, 0, len(f.scope))
	keptPos := make([]int, 0, len(f.scope))
	fixed := make(map[int]int)
	for p, vIdx := range f.scope {
		if dIdx, ok := evidence[m.vars[vIdx].ID]; ok {
			fixed[vIdx] = dIdx
		} else {
			kept = append(kept, vIdx)
			keptPos = append(keptPos, p)
		}
	}
	if len(fixed) == 0 {
		return m.cloneFactor(f)
	}

	out := &ifactor{scope: kept, table: make(map[string]*big.Rat, len(f.table))}
	for key, val := range f.table {
		compatible := true
		for vIdx, dIdx := range fixed {
			p := sort.SearchInts(f.scope, vIdx)
			if int(key[p]) != dIdx {
				compatible = false
				break
			}
		}
		if !compatible {
			continue
		}
		nk := make([]byte, len(kept))
		for i, p := range keptPos {
			nk[i] = key[p]
		}
		out.table[string(nk)] = new(big.Rat).Set(val)
	}
	return out
}

func (m *Model) cloneFactor(f *ifactor) *ifactor {
	out := &ifactor{scope: append([]int(nil), f.scope...), table: make(map[string]*big.Rat, len(f.table))}
	for k, v := range f.table {
		out.table[k] = new(big.Rat).Set(v)
	}
	return out
}

// multiply 在结合 scope 上做稀疏乘法。任一因子为空表时结果即为空表，
// 不枚举任何完整世界。
func (m *Model) multiply(factors []*ifactor) *ifactor {
	union := make([]int, 0)
	unionSet := make(map[int]bool)
	for _, f := range factors {
		for _, vIdx := range f.scope {
			if !unionSet[vIdx] {
				unionSet[vIdx] = true
				union = append(union, vIdx)
			}
		}
	}
	sort.Ints(union)

	out := &ifactor{scope: union, table: make(map[string]*big.Rat)}
	if len(factors) == 0 {
		out.table[""] = big.NewRat(1, 1)
		return out
	}

	positions := make([][]int, len(factors))
	for i, f := range factors {
		positions[i] = make([]int, len(f.scope))
		for j, vIdx := range f.scope {
			positions[i][j] = sort.SearchInts(union, vIdx)
		}
	}

	// 以单位 1 初始化所有结合域元组，逐因子把表项投影到结合域并相乘；
	// 因子未列出的元组精确为 0，直接令该结合域元组归零。
	combined := make([]byte, len(union))
	var build func(axis int)
	build = func(axis int) {
		if axis == len(union) {
			key := string(combined)
			prod := big.NewRat(1, 1)
			for fi, f := range factors {
				local := make([]byte, len(f.scope))
				for j := range f.scope {
					local[j] = combined[positions[fi][j]]
				}
				val, ok := f.table[string(local)]
				if !ok {
					prod.SetInt64(0)
					break
				}
				prod.Mul(prod, val)
			}
			if prod.Sign() != 0 {
				out.table[key] = prod
			}
			return
		}
		v := union[axis]
		for d := 0; d < m.domSize[v]; d++ {
			combined[axis] = byte(d)
			build(axis + 1)
		}
	}
	build(0)
	return out
}

// sumOut 沿变量 v 对因子求和，返回去掉 v 轴的新因子。
func (m *Model) sumOut(f *ifactor, v int) *ifactor {
	pos := sort.SearchInts(f.scope, v)
	if pos < 0 || pos >= len(f.scope) || f.scope[pos] != v {
		panic("dataeng: internal error: variable absent in sumOut")
	}
	kept := make([]int, 0, len(f.scope)-1)
	for i, vIdx := range f.scope {
		if i != pos {
			kept = append(kept, vIdx)
		}
	}
	out := &ifactor{scope: kept, table: make(map[string]*big.Rat, len(f.table))}
	for key, val := range f.table {
		nk := make([]byte, len(kept))
		write := 0
		for read := range key {
			if read != pos {
				nk[write] = key[read]
				write++
			}
		}
		sk := string(nk)
		if acc, ok := out.table[sk]; ok {
			acc.Add(acc, val)
		} else {
			out.table[sk] = new(big.Rat).Set(val)
		}
	}
	return out
}

// syntheticUnary 构造 scope={v}、每个域取值均为 1 的因子，用于没有任何
// 因子提及的孤立隐藏变量。
func (m *Model) syntheticUnary(v int) *ifactor {
	f := &ifactor{scope: []int{v}, table: make(map[string]*big.Rat, m.domSize[v])}
	for d := 0; d < m.domSize[v]; d++ {
		f.table[string([]byte{byte(d)})] = big.NewRat(1, 1)
	}
	return f
}
