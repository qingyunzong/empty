// Package statlabels 提供基于标签树的事件统计。
//
// 标签组织为一棵树（删边后可能退化为森林）。一条事件可被打上多个
// 标签节点；在某个祖先节点上汇总时，同一条事件无论命中该子树内多少
// 个标签，都只计一次。删除树边会改变节点的归属（子树成员关系），
// 但不会改动事件上已打的原始标签。
package statlabels

import "fmt"

// Tree 表示标签树（删边后可为森林）。节点以字符串 ID 标识。
type Tree struct {
	nodes    map[string]struct{}
	parent   map[string]string
	children map[string]map[string]struct{}
}

// NewTree 创建一棵空标签树。
func NewTree() *Tree {
	return &Tree{
		nodes:    make(map[string]struct{}),
		parent:   make(map[string]string),
		children: make(map[string]map[string]struct{}),
	}
}

// AddNode 向树中注册一个节点（幂等）。
func (t *Tree) AddNode(id string) {
	if _, ok := t.nodes[id]; ok {
		return
	}
	t.nodes[id] = struct{}{}
	t.children[id] = make(map[string]struct{})
}

// Has 报告节点是否存在。
func (t *Tree) Has(id string) bool {
	_, ok := t.nodes[id]
	return ok
}

// AddEdge 建立 parent -> child 的树边。任一端不存在时自动注册。
// child 已有父节点或该边会成环时返回错误。
func (t *Tree) AddEdge(parent, child string) error {
	t.AddNode(parent)
	t.AddNode(child)
	if parent == child {
		return fmt.Errorf("statlabels: self edge %q", parent)
	}
	if _, ok := t.parent[child]; ok {
		return fmt.Errorf("statlabels: node %q already has a parent", child)
	}
	if t.IsAncestor(child, parent) {
		return fmt.Errorf("statlabels: edge %q -> %q would create a cycle", parent, child)
	}
	t.parent[child] = parent
	t.children[parent][child] = struct{}{}
	return nil
}

// DeleteEdge 删除 parent -> child 的树边。child 的子树整体脱离，
// 成为森林中独立的一棵；事件上的原始标签不受影响。
// 边不存在时返回错误。
func (t *Tree) DeleteEdge(parent, child string) error {
	p, ok := t.parent[child]
	if !ok || p != parent {
		return fmt.Errorf("statlabels: no edge %q -> %q", parent, child)
	}
	delete(t.parent, child)
	delete(t.children[parent], child)
	return nil
}

// Parent 返回节点的父节点；根节点或不存在时 ok 为 false。
func (t *Tree) Parent(id string) (p string, ok bool) {
	p, ok = t.parent[id]
	return
}

// IsAncestor 报告 anc 是否为 id 的祖先（含自身，即 anc == id 时为 true）。
// 沿父指针向上可达即视为祖先。
func (t *Tree) IsAncestor(anc, id string) bool {
	if !t.Has(anc) || !t.Has(id) {
		return false
	}
	for cur := id; ; {
		if cur == anc {
			return true
		}
		p, ok := t.parent[cur]
		if !ok {
			return false
		}
		cur = p
	}
}

// Descendants 返回 id 及其全部后代节点集合（含自身）。
func (t *Tree) Descendants(id string) map[string]struct{} {
	out := make(map[string]struct{})
	if !t.Has(id) {
		return out
	}
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if _, seen := out[cur]; seen {
			continue
		}
		out[cur] = struct{}{}
		for c := range t.children[cur] {
			stack = append(stack, c)
		}
	}
	return out
}
