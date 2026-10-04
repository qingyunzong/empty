package main

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Op 表示一个读写操作。Kind 为 'R' 或 'W'，Item 为数据项名。
// 版本语义：事务 t 的 W 操作产生数据项的版本 t；初始版本为 0。
// R 操作读取调度中它之前最近一次写入的版本（无则读初始版本 0）。
type Op struct {
	Txn  int
	Kind byte
	Item string
}

// Edge 是依赖图中的一条具体冲突边，方向为调度中先发生的操作指向后发生的操作。
// Kind: "WR"(写后读/读自), "RW"(读后写/反依赖), "WW"(写后写)。
type Edge struct {
	From, To int
	Kind     string
	Item     string
	FromSeq  int // 源操作在调度中的下标
	ToSeq    int // 目标操作在调度中的下标
}

func (e Edge) String() string {
	return fmt.Sprintf("T%d -%s(%s)-> T%d  [%s#%d -> %s#%d]",
		e.From, e.Kind, e.Item, e.To,
		opName(e.Kind, true), e.FromSeq, opName(e.Kind, false), e.ToSeq)
}

func opName(kind string, first bool) string {
	if kind == "WW" {
		return "w"
	}
	if kind == "WR" {
		if first {
			return "w"
		}
		return "r"
	}
	if first {
		return "r"
	}
	return "w"
}

var compactRe = regexp.MustCompile(`^([RrWw])(\d+)\(([A-Za-z0-9_]+)\)$`)

// Parse 解析输入。支持两种记号（可混合）：
//
//	紧凑式: r1(A) w2(B)
//	三元组: 1 R A
//
// '#' 开头的行视为注释。
func Parse(input string) ([]Op, error) {
	var lines []string
	for _, ln := range strings.Split(input, "\n") {
		if i := strings.Index(ln, "#"); i >= 0 {
			ln = ln[:i]
		}
		lines = append(lines, ln)
	}
	toks := strings.Fields(strings.Join(lines, " "))
	var ops []Op
	for i := 0; i < len(toks); {
		if m := compactRe.FindStringSubmatch(toks[i]); m != nil {
			var txn int
			fmt.Sscanf(m[2], "%d", &txn)
			ops = append(ops, Op{Txn: txn, Kind: byte(strings.ToUpper(m[1])[0]), Item: m[3]})
			i++
			continue
		}
		if i+2 >= len(toks) {
			return nil, fmt.Errorf("无法解析记号 %q（需要形如 r1(A) 或 '1 R A'）", toks[i])
		}
		var txn int
		if _, err := fmt.Sscanf(toks[i], "%d", &txn); err != nil {
			return nil, fmt.Errorf("无法解析事务号 %q: %v", toks[i], err)
		}
		kind := strings.ToUpper(toks[i+1])
		if kind != "R" && kind != "W" {
			return nil, fmt.Errorf("无法解析操作类型 %q（应为 R 或 W）", toks[i+1])
		}
		ops = append(ops, Op{Txn: txn, Kind: kind[0], Item: toks[i+2]})
		i += 3
	}
	if len(ops) == 0 {
		return nil, fmt.Errorf("输入为空")
	}
	ids := TxnIDs(ops)
	if len(ids) > 12 {
		return nil, fmt.Errorf("事务数 %d 超过上限 12", len(ids))
	}
	return ops, nil
}

// TxnIDs 返回调度中出现的事务号，升序去重。
func TxnIDs(ops []Op) []int {
	seen := map[int]bool{}
	var ids []int
	for _, op := range ops {
		if !seen[op.Txn] {
			seen[op.Txn] = true
			ids = append(ids, op.Txn)
		}
	}
	sort.Ints(ids)
	return ids
}

// BuildEdges 构造冲突依赖图的所有具体边：
// 同一数据项上、属于不同事务、按调度先后排列且至少有一个写操作的两个操作产生一条边。
func BuildEdges(ops []Op) []Edge {
	var edges []Edge
	for i := 0; i < len(ops); i++ {
		for j := i + 1; j < len(ops); j++ {
			a, b := ops[i], ops[j]
			if a.Txn == b.Txn || a.Item != b.Item {
				continue
			}
			if a.Kind == 'R' && b.Kind == 'R' {
				continue
			}
			kind := string([]byte{a.Kind, b.Kind})
			edges = append(edges, Edge{From: a.Txn, To: b.Txn, Kind: kind, Item: a.Item, FromSeq: i, ToSeq: j})
		}
	}
	return edges
}

// adjacency 返回去重后的邻接表（仅用于图算法），键为源事务。
func adjacency(ids []int, edges []Edge) map[int][]int {
	adj := map[int][]int{}
	seen := map[[2]int]bool{}
	for _, id := range ids {
		adj[id] = nil
	}
	for _, e := range edges {
		k := [2]int{e.From, e.To}
		if !seen[k] {
			seen[k] = true
			adj[e.From] = append(adj[e.From], e.To)
		}
	}
	for id := range adj {
		sort.Ints(adj[id])
	}
	return adj
}

// FindCycle 在依赖图中寻找一个有向环，返回环上的具体冲突边；无环返回 nil。
func FindCycle(ids []int, edges []Edge) []Edge {
	adj := adjacency(ids, edges)
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := map[int]int{}
	var stack []int
	var cycleNodes []int

	var dfs func(u int) bool
	dfs = func(u int) bool {
		color[u] = gray
		stack = append(stack, u)
		for _, v := range adj[u] {
			if color[v] == gray {
				// 找到回边，截取栈中 v..u 部分
				idx := 0
				for i, n := range stack {
					if n == v {
						idx = i
						break
					}
				}
				cycleNodes = append([]int{}, stack[idx:]...)
				return true
			}
			if color[v] == white && dfs(v) {
				return true
			}
		}
		stack = stack[:len(stack)-1]
		color[u] = black
		return false
	}
	for _, id := range ids {
		if color[id] == white && dfs(id) {
			break
		}
	}
	if cycleNodes == nil {
		return nil
	}
	// 将相邻事务对映射回具体冲突边（取调度中最早出现的一条）
	cycleNodes = append(cycleNodes, cycleNodes[0])
	var out []Edge
	for i := 0; i+1 < len(cycleNodes); i++ {
		from, to := cycleNodes[i], cycleNodes[i+1]
		for _, e := range edges {
			if e.From == from && e.To == to {
				out = append(out, e)
				break
			}
		}
	}
	return out
}

// TopoMinID 使用 Kahn 算法，每轮在入度为 0 的事务中取 ID 最小者。
// 返回每轮一个事务的拓扑序列；若有环则 ok=false。
func TopoMinID(ids []int, edges []Edge) (order []int, ok bool) {
	adj := adjacency(ids, edges)
	indeg := map[int]int{}
	for _, id := range ids {
		indeg[id] = 0
	}
	for _, vs := range adj {
		for _, v := range vs {
			indeg[v]++
		}
	}
	remaining := map[int]bool{}
	for _, id := range ids {
		remaining[id] = true
	}
	for len(remaining) > 0 {
		best := -1
		for id := range remaining {
			if indeg[id] == 0 && (best == -1 || id < best) {
				best = id
			}
		}
		if best == -1 {
			return nil, false
		}
		order = append(order, best)
		delete(remaining, best)
		for _, v := range adj[best] {
			indeg[v]--
		}
	}
	return order, true
}

// ReadVersions 按给定事务顺序串行重放（每个事务内部保持原操作相对顺序），
// 返回每个读操作（以调度下标标识）实际读到的版本号（写入事务号，初始版本为 0）。
func ReadVersions(ops []Op, order []int) map[int]int {
	byTxn := map[int][]int{}
	for i, op := range ops {
		byTxn[op.Txn] = append(byTxn[op.Txn], i)
	}
	version := map[string]int{}
	read := map[int]int{}
	for _, t := range order {
		for _, i := range byTxn[t] {
			op := ops[i]
			if op.Kind == 'R' {
				read[i] = version[op.Item]
			} else {
				version[op.Item] = op.Txn
			}
		}
	}
	return read
}

// OriginalReads 按原调度顺序模拟，返回每个读操作读到的版本号。
func OriginalReads(ops []Op) map[int]int {
	version := map[string]int{}
	read := map[int]int{}
	for i, op := range ops {
		if op.Kind == 'R' {
			read[i] = version[op.Item]
		} else {
			version[op.Item] = op.Txn
		}
	}
	return read
}

// ReplayEquivalent 独立重放验证：串行顺序 order 下所有读操作读到的版本
// 与原调度完全一致时返回 true。
func ReplayEquivalent(ops []Op, order []int) bool {
	orig := OriginalReads(ops)
	replay := ReadVersions(ops, order)
	if len(orig) != len(replay) {
		return false
	}
	for i, v := range orig {
		if replay[i] != v {
			return false
		}
	}
	return true
}

// EnumerateValidOrders 枚举事务的全部排列，重放验证后返回所有与原调度
// 读版本一致的串行顺序。仅供小规模历史对照（n! 增长）。
func EnumerateValidOrders(ids []int, ops []Op) [][]int {
	var valid [][]int
	perm := make([]int, len(ids))
	used := make([]bool, len(ids))
	var rec func(pos int)
	rec = func(pos int) {
		if pos == len(ids) {
			cand := append([]int{}, perm...)
			if ReplayEquivalent(ops, cand) {
				valid = append(valid, cand)
			}
			return
		}
		for i := range ids {
			if !used[i] {
				used[i] = true
				perm[pos] = ids[i]
				rec(pos + 1)
				used[i] = false
			}
		}
	}
	rec(0)
	return valid
}
