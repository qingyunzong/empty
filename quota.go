// Package quotatree 维护组织配额树：节点领取量沿父链汇总至祖先，
// 子树移动时校验新祖先链上限，失败则结构与计数保持不变。
package quotatree

import "fmt"

// Node 是配额树节点。Total 为子树领取总量（含自身），
// OverLimit 标记 Total 是否超过 Quota（额度下调后可能为真）。
type Node struct {
	ID        string
	Quota     int64
	Claimed   int64 // 本节点自身领取量
	Total     int64 // 子树领取总量（缓存，由 Claim/Move 增量维护）
	Parent    *Node
	Children  map[string]*Node
	OverLimit bool
}

// Tree 持有根节点与全量索引。
type Tree struct {
	Root  *Node
	nodes map[string]*Node
}

// NewTree 创建只有根节点的配额树。
func NewTree(rootID string, quota int64) *Tree {
	root := &Node{ID: rootID, Quota: quota, Children: map[string]*Node{}}
	return &Tree{Root: root, nodes: map[string]*Node{rootID: root}}
}

// Get 返回节点，不存在时 ok=false。
func (t *Tree) Get(id string) (n *Node, ok bool) {
	n, ok = t.nodes[id]
	return
}

// AddNode 在 parentID 下新增节点。
func (t *Tree) AddNode(parentID, id string, quota int64) error {
	if _, dup := t.nodes[id]; dup {
		return fmt.Errorf("quotatree: node %q already exists", id)
	}
	p, ok := t.nodes[parentID]
	if !ok {
		return fmt.Errorf("quotatree: parent %q not found", parentID)
	}
	n := &Node{ID: id, Quota: quota, Parent: p, Children: map[string]*Node{}}
	p.Children[id] = n
	t.nodes[id] = n
	return nil
}

func (n *Node) refreshLimit() { n.OverLimit = n.Total > n.Quota }

// addTotal 沿父链向上累加 delta 并刷新超额标记。
func addTotal(n *Node, delta int64) {
	for cur := n; cur != nil; cur = cur.Parent {
		cur.Total += delta
		cur.refreshLimit()
	}
}

// Claim 记录节点自身领取量，并汇总至全部祖先。
// 允许超额领取，超额节点会被标记 OverLimit。
func (t *Tree) Claim(id string, amount int64) error {
	if amount < 0 {
		return fmt.Errorf("quotatree: negative claim %d", amount)
	}
	n, ok := t.nodes[id]
	if !ok {
		return fmt.Errorf("quotatree: node %q not found", id)
	}
	n.Claimed += amount
	addTotal(n, amount)
	return nil
}

// Move 将 id 的子树整体挂到 newParentID 下。
// 根不可移动；禁止挂到自身子树内（成环）；新祖先链上任一节点
// 加上子树总量后超过额度则整体失败，结构与计数保持不变。
func (t *Tree) Move(id, newParentID string) error {
	n, ok := t.nodes[id]
	if !ok {
		return fmt.Errorf("quotatree: node %q not found", id)
	}
	if n == t.Root {
		return fmt.Errorf("quotatree: root cannot be moved")
	}
	np, ok := t.nodes[newParentID]
	if !ok {
		return fmt.Errorf("quotatree: new parent %q not found", newParentID)
	}
	// 成环检查：新父节点不得在待移动子树内。
	for cur := np; cur != nil; cur = cur.Parent {
		if cur == n {
			return fmt.Errorf("quotatree: moving %q under %q would create a cycle", id, newParentID)
		}
	}
	if n.Parent == np {
		return nil // 已在目标父节点下，视为成功
	}
	delta := n.Total
	// 预检新祖先链上限（不做任何修改）。
	for cur := np; cur != nil; cur = cur.Parent {
		if cur.Total+delta > cur.Quota {
			return fmt.Errorf("quotatree: move rejected, ancestor %q quota %d would be exceeded (%d+%d)",
				cur.ID, cur.Quota, cur.Total, delta)
		}
	}
	// 预检通过，先摘后挂，两侧祖先链分别调整计数。
	addTotal(n.Parent, -delta)
	delete(n.Parent.Children, n.ID)
	n.Parent = np
	np.Children[n.ID] = n
	addTotal(np, delta)
	return nil
}

// SetQuota 调整节点额度。允许下调至低于当前用量，此时节点被标记超额。
func (t *Tree) SetQuota(id string, quota int64) error {
	n, ok := t.nodes[id]
	if !ok {
		return fmt.Errorf("quotatree: node %q not found", id)
	}
	n.Quota = quota
	n.refreshLimit()
	return nil
}

// Verify 逐节点重算子树总量与超额标记，并与缓存值核对；
// 同时校验父子指针与索引一致性。用于长操作序列后的整体核验。
func (t *Tree) Verify() error {
	if t.Root.Parent != nil {
		return fmt.Errorf("quotatree: root %q has a parent", t.Root.ID)
	}
	seen := map[*Node]bool{}
	var walk func(n *Node) (int64, error)
	walk = func(n *Node) (int64, error) {
		if seen[n] {
			return 0, fmt.Errorf("quotatree: cycle or duplicate reference at %q", n.ID)
		}
		seen[n] = true
		if t.nodes[n.ID] != n {
			return 0, fmt.Errorf("quotatree: index mismatch for %q", n.ID)
		}
		sum := n.Claimed
		for _, c := range n.Children {
			if c.Parent != n {
				return 0, fmt.Errorf("quotatree: child %q parent pointer broken", c.ID)
			}
			cs, err := walk(c)
			if err != nil {
				return 0, err
			}
			sum += cs
		}
		if sum != n.Total {
			return 0, fmt.Errorf("quotatree: node %q cached total %d, recomputed %d", n.ID, n.Total, sum)
		}
		if want := n.Total > n.Quota; want != n.OverLimit {
			return 0, fmt.Errorf("quotatree: node %q over-limit flag %v, want %v", n.ID, n.OverLimit, want)
		}
		return sum, nil
	}
	if _, err := walk(t.Root); err != nil {
		return err
	}
	if len(seen) != len(t.nodes) {
		return fmt.Errorf("quotatree: %d nodes indexed, %d reachable from root", len(t.nodes), len(seen))
	}
	return nil
}
