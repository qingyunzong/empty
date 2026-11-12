// Package liveness 为数据湖宿主提供文件存活判定：输入一棵提交 DAG，
// 按逐提交集合模型推导每个提交点的活文件集合，并为一组保留提交
// 给出应保留文件及其存在证据路径。
package liveness

import (
	"errors"
	"fmt"
	"sort"
)

// File 以 ID 与摘要共同标识一个文件版本。
type File struct {
	ID     string
	Digest string
}

// Commit 描述 DAG 中的一个提交：父提交 ID 列表、加入文件集合与移除文件 ID 集合。
type Commit struct {
	ID      string
	Parents []string
	Adds    []File
	Removes []string
}

var (
	ErrDuplicateCommit    = errors.New("liveness: duplicate commit ID")
	ErrMissingParent      = errors.New("liveness: missing parent commit")
	ErrCycle              = errors.New("liveness: commit graph contains a cycle")
	ErrDuplicateOperation = errors.New("liveness: duplicate file operation in commit")
	ErrDigestConflict     = errors.New("liveness: conflicting digests for file ID")
	ErrUnknownCommit      = errors.New("liveness: unknown commit")
)

type node struct {
	commit Commit
	live   map[string]string // file ID -> digest
	origin map[string]string // file ID -> 引入该文件的提交 ID
}

// Graph 是校验通过的提交 DAG，已按拓扑序算出各提交的活文件集合。
type Graph struct {
	nodes map[string]*node
}

// NewGraph 校验提交 DAG 并计算每个提交的活文件集合。
// 任一提交缺父、图中有环、同一提交内对同一文件重复操作，
// 或同一文件 ID 在图中出现不同摘要，都会拒绝整份图。
func NewGraph(commits ...Commit) (*Graph, error) {
	nodes := make(map[string]*node, len(commits))
	for _, c := range commits {
		if c.ID == "" {
			return nil, fmt.Errorf("%w: empty commit ID", ErrDuplicateCommit)
		}
		if _, dup := nodes[c.ID]; dup {
			return nil, fmt.Errorf("%w: %q", ErrDuplicateCommit, c.ID)
		}
		if err := checkOperations(c); err != nil {
			return nil, err
		}
		nodes[c.ID] = &node{commit: c}
	}
	for _, c := range commits {
		for _, p := range c.Parents {
			if _, ok := nodes[p]; !ok {
				return nil, fmt.Errorf("%w: commit %q references %q", ErrMissingParent, c.ID, p)
			}
		}
	}
	digests := make(map[string]string)
	for _, c := range commits {
		for _, f := range c.Adds {
			if d, ok := digests[f.ID]; ok && d != f.Digest {
				return nil, fmt.Errorf("%w: %q has digests %q and %q", ErrDigestConflict, f.ID, d, f.Digest)
			}
			digests[f.ID] = f.Digest
		}
	}
	order, err := topoOrder(nodes)
	if err != nil {
		return nil, err
	}
	g := &Graph{nodes: nodes}
	for _, id := range order {
		g.computeLive(nodes[id])
	}
	return g, nil
}

// checkOperations 拒绝同一提交内对同一文件 ID 的重复操作：
// 重复加入、重复移除、或同一文件既加入又移除。
func checkOperations(c Commit) error {
	added := make(map[string]struct{}, len(c.Adds))
	for _, f := range c.Adds {
		if _, dup := added[f.ID]; dup {
			return fmt.Errorf("%w: commit %q adds %q twice", ErrDuplicateOperation, c.ID, f.ID)
		}
		added[f.ID] = struct{}{}
	}
	removed := make(map[string]struct{}, len(c.Removes))
	for _, id := range c.Removes {
		if _, dup := removed[id]; dup {
			return fmt.Errorf("%w: commit %q removes %q twice", ErrDuplicateOperation, c.ID, id)
		}
		removed[id] = struct{}{}
		if _, both := added[id]; both {
			return fmt.Errorf("%w: commit %q both adds and removes %q", ErrDuplicateOperation, c.ID, id)
		}
	}
	return nil
}

// topoOrder 返回父先子后的拓扑序；有环时报错。
func topoOrder(nodes map[string]*node) ([]string, error) {
	const (
		unvisited = 0
		inStack   = 1
		done      = 2
	)
	state := make(map[string]int, len(nodes))
	order := make([]string, 0, len(nodes))
	var visit func(id string) error
	visit = func(id string) error {
		switch state[id] {
		case done:
			return nil
		case inStack:
			return fmt.Errorf("%w: commit %q", ErrCycle, id)
		}
		state[id] = inStack
		for _, p := range nodes[id].commit.Parents {
			if err := visit(p); err != nil {
				return err
			}
		}
		state[id] = done
		order = append(order, id)
		return nil
	}
	ids := make([]string, 0, len(nodes))
	for id := range nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if err := visit(id); err != nil {
			return nil, err
		}
	}
	return order, nil
}

// computeLive 计算单提交的活文件集合：多父取并集，先移除再加入。
// 同时记录每个活文件在本支系中的引入提交，作为证据路径的终点。
func (g *Graph) computeLive(n *node) {
	live := make(map[string]string)
	origin := make(map[string]string)
	for _, p := range n.commit.Parents {
		pn := g.nodes[p]
		for id, d := range pn.live {
			if _, seen := live[id]; !seen {
				live[id] = d
				origin[id] = pn.origin[id]
			}
		}
	}
	for _, id := range n.commit.Removes {
		delete(live, id)
		delete(origin, id)
	}
	for _, f := range n.commit.Adds {
		live[f.ID] = f.Digest
		origin[f.ID] = n.commit.ID
	}
	n.live = live
	n.origin = origin
}

// LiveFiles 返回指定提交点的活文件集合（file ID -> digest）。
func (g *Graph) LiveFiles(commitID string) (map[string]string, error) {
	n, ok := g.nodes[commitID]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownCommit, commitID)
	}
	out := make(map[string]string, len(n.live))
	for id, d := range n.live {
		out[id] = d
	}
	return out, nil
}

// Evidence 是一个应保留文件的存在证据：文件本身，以及从某个保留提交
// 沿父链回溯到引入该文件提交的提交 ID 路径（首元素为保留提交）。
type Evidence struct {
	File File
	Path []string
}

// Retention 是对一组保留提交的存活判定结果。
type Retention struct {
	Files    []File              // 应保留文件，按 ID 排序
	Evidence map[string]Evidence // file ID -> 证据
}

// Retain 计算一组保留提交应保留的文件集合（各保留提交活文件集合的并集），
// 并为每个文件给出一条从保留提交推导的存在证据路径。
// 未被保留提交引用的祖先不算保留点：只存活于非保留祖先中的文件不在结果中。
func (g *Graph) Retain(retained []string) (*Retention, error) {
	roots := make([]string, 0, len(retained))
	seen := make(map[string]struct{}, len(retained))
	for _, id := range retained {
		if _, ok := g.nodes[id]; !ok {
			return nil, fmt.Errorf("%w: %q", ErrUnknownCommit, id)
		}
		if _, dup := seen[id]; !dup {
			seen[id] = struct{}{}
			roots = append(roots, id)
		}
	}
	sort.Strings(roots)
	ret := &Retention{Evidence: make(map[string]Evidence)}
	picked := make(map[string]struct{})
	for _, root := range roots {
		n := g.nodes[root]
		for id, digest := range n.live {
			if _, ok := picked[id]; ok {
				continue
			}
			picked[id] = struct{}{}
			f := File{ID: id, Digest: digest}
			ret.Files = append(ret.Files, f)
			ret.Evidence[id] = Evidence{File: f, Path: g.evidencePath(root, n.origin[id], id)}
		}
	}
	sort.Slice(ret.Files, func(i, j int) bool { return ret.Files[i].ID < ret.Files[j].ID })
	return ret, nil
}

// evidencePath 用 BFS 在父链上找从 from 到 to 的最短提交路径，
// 且路径上每个提交都必须持有该文件（文件存活链）。
// to 是 from 支系中该文件的引入提交，路径必然存在。
func (g *Graph) evidencePath(from, to, fileID string) []string {
	prev := map[string]string{from: ""}
	queue := []string{from}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		if cur == to {
			path := []string{to}
			for c := prev[to]; c != ""; c = prev[c] {
				path = append([]string{c}, path...)
			}
			return path
		}
		for _, p := range g.nodes[cur].commit.Parents {
			if _, ok := prev[p]; ok {
				continue
			}
			if _, alive := g.nodes[p].live[fileID]; alive {
				prev[p] = cur
				queue = append(queue, p)
			}
		}
	}
	return nil
}
