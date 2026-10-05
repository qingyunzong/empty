// Package causalmsg 提供基于向量时钟的因果消息交付。
//
// 语义：
//   - 消息仅当其全部因果前置事件都已交付时才交付；
//   - 缺少前置的消息保留在缓冲区中等待，绝不按时间戳强行交付；
//   - 相同 ID 且内容相同的消息为幂等重复，直接忽略；
//   - 相同 ID 但内容不同的消息被拒绝（ConflictError）；
//   - Close 返回缓冲区中仍未满足依赖的消息及其缺失的前置。
package causalmsg

import (
	"bytes"
	"errors"
	"fmt"
	"sort"
)

// ErrClosed 在节点关闭后继续 Receive 时返回。
var ErrClosed = errors.New("causalmsg: node is closed")

// ConflictError 表示同一消息 ID 被赋予了不同内容。
type ConflictError struct {
	ID string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("causalmsg: message ID %q reused with different content", e.ID)
}

// Message 是一条携带向量时钟的消息。
type Message struct {
	ID      string
	From    string
	Clock   VectorClock
	Payload []byte
}

func (m Message) sameContent(o Message) bool {
	return m.From == o.From &&
		bytes.Equal(m.Payload, o.Payload) &&
		m.Clock.Equal(o.Clock)
}

// Dependency 描述一条未满足的因果前置：节点 Node 的事件，
// 本地已交付到 Have，消息需要到 Need。
type Dependency struct {
	Node string
	Have uint64
	Need uint64
}

// Pending 是一条仍在缓冲的消息及其缺失的前置依赖。
type Pending struct {
	Message Message
	Missing []Dependency
}

// Node 是因果交付节点。Node 不是并发安全的。
type Node struct {
	id        string
	clock     VectorClock
	seen      map[string]Message
	buffer    []Message
	delivered []Message
	closed    bool
}

// NewNode 创建一个节点，id 用于本地广播的向量时钟分量。
func NewNode(id string) *Node {
	return &Node{
		id:    id,
		clock: VectorClock{},
		seen:  make(map[string]Message),
	}
}

// Broadcast 递增本地时钟，构造一条消息并立即在本地交付。
func (n *Node) Broadcast(payload []byte) Message {
	n.clock[n.id]++
	m := Message{
		ID:      fmt.Sprintf("%s:%d", n.id, n.clock[n.id]),
		From:    n.id,
		Clock:   n.clock.Clone(),
		Payload: payload,
	}
	n.seen[m.ID] = m
	n.delivered = append(n.delivered, m)
	return m
}

// Receive 接收一条消息。因果就绪则交付并连带冲刷缓冲区；
// 否则保留在缓冲区等待前置事件。重复 ID 内容一致时幂等忽略，
// 内容不一致时返回 *ConflictError。
func (n *Node) Receive(m Message) error {
	if n.closed {
		return ErrClosed
	}
	if prev, ok := n.seen[m.ID]; ok {
		if !prev.sameContent(m) {
			return &ConflictError{ID: m.ID}
		}
		return nil
	}
	n.seen[m.ID] = m
	if n.ready(m) {
		n.deliver(m)
		n.drain()
	} else {
		n.buffer = append(n.buffer, m)
	}
	return nil
}

// ready 报告消息的全部因果前置是否都已交付：
// 发送方序号必须恰好是下一个，其余分量不得超过本地时钟。
func (n *Node) ready(m Message) bool {
	if m.Clock[m.From] != n.clock[m.From]+1 {
		return false
	}
	for k, v := range m.Clock {
		if k == m.From {
			continue
		}
		if v > n.clock[k] {
			return false
		}
	}
	return true
}

func (n *Node) deliver(m Message) {
	n.clock.merge(m.Clock)
	n.delivered = append(n.delivered, m)
}

// drain 反复扫描缓冲区，交付所有变为就绪的消息。
func (n *Node) drain() {
	for {
		progressed := false
		rest := n.buffer[:0]
		for _, m := range n.buffer {
			if n.ready(m) {
				n.deliver(m)
				progressed = true
			} else {
				rest = append(rest, m)
			}
		}
		n.buffer = rest
		if !progressed {
			return
		}
	}
}

// Delivered 返回已交付消息的副本，按交付顺序排列。
func (n *Node) Delivered() []Message {
	out := make([]Message, len(n.delivered))
	copy(out, n.delivered)
	return out
}

// Pending 返回缓冲区中仍等待前置的消息及其缺失依赖。
func (n *Node) Pending() []Pending {
	out := make([]Pending, 0, len(n.buffer))
	for _, m := range n.buffer {
		out = append(out, Pending{Message: m, Missing: n.missing(m)})
	}
	return out
}

func (n *Node) missing(m Message) []Dependency {
	keys := make([]string, 0, len(m.Clock))
	for k := range m.Clock {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var deps []Dependency
	for _, k := range keys {
		if need := m.Clock[k]; need > n.clock[k] {
			deps = append(deps, Dependency{Node: k, Have: n.clock[k], Need: need})
		}
	}
	return deps
}

// Close 关闭节点，并返回缓冲区中依赖未满足的消息列表。
func (n *Node) Close() []Pending {
	n.closed = true
	return n.Pending()
}
