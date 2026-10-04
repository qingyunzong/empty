package main

import "fmt"

// ReadCheck 记录一次读操作在串行重放中的版本核对结果。
type ReadCheck struct {
	Txn  int
	Item string
	Want int // 历史声明读到的版本
	Got  int // 串行重放实际读到的版本（0 表示尚无版本）
	OK   bool
}

func (rc ReadCheck) String() string {
	got := fmt.Sprintf("%s%d", rc.Item, rc.Got)
	if rc.Got == 0 {
		got = "∅(无版本)"
	}
	mark := "✓"
	if !rc.OK {
		mark = "✗"
	}
	return fmt.Sprintf("T%d 读 %s: 期望 %s%d, 实际 %s %s",
		rc.Txn, rc.Item, rc.Item, rc.Want, got, mark)
}

// Replay 独立重放：按给定串行序依次执行各事务的操作
// （同一事务内保持历史中的相对顺序）。读操作读到的是
// 已写版本中按版本序（历史写序）最新的版本——与 MVSG
// 的固定版本序语义一致。核对每个读操作实际读到的版本
// 是否与历史声明一致。不依赖依赖图逻辑。
func Replay(h *History, order []int) ([]ReadCheck, bool) {
	opsByTxn := map[int][]Op{}
	writePos := map[string]map[int]int{} // item -> 写者事务 -> 历史位置(版本序)
	for _, op := range h.Ops {
		opsByTxn[op.Txn] = append(opsByTxn[op.Txn], op)
		if op.Kind == 'W' {
			if writePos[op.Item] == nil {
				writePos[op.Item] = map[int]int{}
			}
			writePos[op.Item][op.Txn] = op.Pos
		}
	}
	written := map[string][]int{} // item -> 已写版本的写者事务
	var checks []ReadCheck
	ok := true
	for _, txn := range order {
		for _, op := range opsByTxn[txn] {
			if op.Kind == 'W' {
				written[op.Item] = append(written[op.Item], op.Txn)
				continue
			}
			got := 0
			best := -1
			for _, w := range written[op.Item] {
				if p := writePos[op.Item][w]; p > best {
					best = p
					got = w
				}
			}
			c := ReadCheck{Txn: op.Txn, Item: op.Item, Want: op.Version, Got: got, OK: got == op.Version}
			checks = append(checks, c)
			if !c.OK {
				ok = false
			}
		}
	}
	return checks, ok
}

// EnumeratePermutations 枚举事务的全部排列，重放并统计有效串行序。
// 仅适合小规模（n <= 8）。
func EnumeratePermutations(h *History) (valid [][]int, total int) {
	n := len(h.Txns)
	perm := make([]int, n)
	copy(perm, h.Txns)
	var rec func(k int)
	rec = func(k int) {
		if k == n {
			total++
			if _, ok := Replay(h, perm); ok {
				cp := make([]int, n)
				copy(cp, perm)
				valid = append(valid, cp)
			}
			return
		}
		for i := k; i < n; i++ {
			perm[k], perm[i] = perm[i], perm[k]
			rec(k + 1)
			perm[k], perm[i] = perm[i], perm[k]
		}
	}
	rec(0)
	return valid, total
}
