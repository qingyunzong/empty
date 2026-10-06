// Package quotatree 维护一个带权配额树：每个节点有额度上限 Limit 与自身领取量，
// 子树领取量聚合缓存至每个祖先。移动子树时对新祖先链做上限检查，
// 失败时结构与计数保持不变。根不可移动，禁止成环，允许下调额度（超额仅标记）。
package quotatree

import (
	"errors"
	"fmt"
)

var (
	ErrNodeNotFound  = errors.New("quotatree: node not found")
	ErrDuplicateID   = errors.New("quotatree: duplicate node id")
	ErrRootMovable   = errors.New("quotatree: root cannot be moved")
	ErrCycle         = errors.New("quotatree: move would create a cycle")
	ErrQuotaExceeded = errors.New("quotatree: quota limit exceeded")
	ErrInvalidAmount = errors.New("quotatree: invalid amount")
)

// Node 是配额树节点。Total 为子树聚合领取量（含自身），由树自动维护。
type Node struct {
	ID       string
	Limit    int64
	own      int64
	total    int64
	parent   *Node
	children map[string]*Node
}

// Own 返回节点自身领取量（不含子孙）。
func (n *Node) Own() int64 { return n.own }

// Total 返回子树聚合领取量。
func (n *Node) Total() int64 { return n.total }

// Parent 返回父节点 ID，根返回空串。
func (n *Node) Parent() string {
	if n.parent == nil {
		return ""
	}
	return n.parent.ID
}

// OverQuota 报告聚合领取量是否超过当前额度上限。
func (n *Node) OverQuota() bool { return n.total > n.Limit }

// Tree 是配额树。
type Tree struct {
	root  *Node
	nodes map[string]*Node
}

// New 创建只有根的配额树。
func New(rootID string, limit int64) (*Tree, error) {
	if limit < 0 {
		return nil, ErrInvalidAmount
	}
	root := &Node{ID: rootID, Limit: limit, children: map[string]*Node{}}
	return &Tree{root: root, nodes: map[string]*Node{rootID: root}}, nil
}

// Root 返回根节点。
func (t *Tree) Root() *Node { return t.root }

// Get 按 ID 查找节点。
func (t *Tree) Get(id string) (*Node, bool) {
	n, ok := t.nodes[id]
	return n, ok
}

// Len 返回节点数。
func (t *Tree) Len() int { return len(t.nodes) }

// Add 在 parentID 下新增子节点。
func (t *Tree) Add(parentID, id string, limit int64) error {
	if limit < 0 {
		return ErrInvalidAmount
	}
	if _, dup := t.nodes[id]; dup {
		return ErrDuplicateID
	}
	parent, ok := t.nodes[parentID]
	if !ok {
		return ErrNodeNotFound
	}
	n := &Node{ID: id, Limit: limit, parent: parent, children: map[string]*Node{}}
	parent.children[id] = n
	t.nodes[id] = n
	return nil
}

// Claim 为节点增加领取量 delta（可为负表示回收，但自身领取量不得低于 0）。
// 沿祖先链检查上限，任一节点将超额则整体失败，计数不变。
func (t *Tree) Claim(id string, delta int64) error {
	n, ok := t.nodes[id]
	if !ok {
		return ErrNodeNotFound
	}
	if n.own+delta < 0 {
		return ErrInvalidAmount
	}
	for a := n; a != nil; a = a.parent {
		if a.total+delta > a.Limit {
			return fmt.Errorf("%w: node %s limit %d, would become %d",
				ErrQuotaExceeded, a.ID, a.Limit, a.total+delta)
		}
	}
	n.own += delta
	for a := n; a != nil; a = a.parent {
		a.total += delta
	}
	return nil
}

// SetLimit 调整节点额度。允许下调至低于当前聚合量，此时节点处于超额状态
// （OverQuota 为 true），结构与计数不变。
func (t *Tree) SetLimit(id string, limit int64) error {
	if limit < 0 {
		return ErrInvalidAmount
	}
	n, ok := t.nodes[id]
	if !ok {
		return ErrNodeNotFound
	}
	n.Limit = limit
	return nil
}

// Move 将 id 子树整体挂到 newParentID 下。根不可移动；新父节点不得位于
// 被移动子树内（禁止成环）；新祖先链上每个节点的聚合量加上子树总量后
// 不得超过其上限，任一失败则结构与计数完全不变。
func (t *Tree) Move(id, newParentID string) error {
	n, ok := t.nodes[id]
	if !ok {
		return ErrNodeNotFound
	}
	np, ok := t.nodes[newParentID]
	if !ok {
		return ErrNodeNotFound
	}
	if n == t.root {
		return ErrRootMovable
	}
	if n == np {
		return ErrCycle
	}
	for a := np; a != nil; a = a.parent {
		if a == n {
			return ErrCycle
		}
	}
	sub := n.total
	for a := np; a != nil; a = a.parent {
		if a.total+sub > a.Limit {
			return fmt.Errorf("%w: node %s limit %d, would become %d",
				ErrQuotaExceeded, a.ID, a.Limit, a.total+sub)
		}
	}
	// 校验全部通过后才修改结构与计数。
	delete(n.parent.children, n.ID)
	for a := n.parent; a != nil; a = a.parent {
		a.total -= sub
	}
	n.parent = np
	np.children[n.ID] = n
	for a := np; a != nil; a = a.parent {
		a.total += sub
	}
	return nil
}

// Verify 逐节点重算子树聚合量并与缓存比对，同时核验父子指针一致性。
// 用于长操作序列后的整体校验；发现不一致时返回首个错误。
func (t *Tree) Verify() error {
	if len(t.nodes) == 0 || t.root == nil {
		return errors.New("quotatree: empty tree")
	}
	visited := make(map[*Node]bool, len(t.nodes))
	var walk func(n *Node) (int64, error)
	walk = func(n *Node) (int64, error) {
		if visited[n] {
			return 0, fmt.Errorf("quotatree: cycle detected at node %s", n.ID)
		}
		visited[n] = true
		sum := n.own
		for _, c := range n.children {
			if c.parent != n {
				return 0, fmt.Errorf("quotatree: node %s parent pointer mismatch", c.ID)
			}
			cs, err := walk(c)
			if err != nil {
				return 0, err
			}
			sum += cs
		}
		if sum != n.total {
			return 0, fmt.Errorf("quotatree: node %s cached total %d, recomputed %d",
				n.ID, n.total, sum)
		}
		return sum, nil
	}
	if _, err := walk(t.root); err != nil {
		return err
	}
	if len(visited) != len(t.nodes) {
		return fmt.Errorf("quotatree: %d of %d nodes reachable from root",
			len(visited), len(t.nodes))
	}
	return nil
}
