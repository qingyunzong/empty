// Package pcheck 实现一个有界协议安全性检查库。
//
// 协议由节点状态表描述：每个节点处于某个命名状态，收到一条已发送的
// 消息后按状态表迁移，并可能发出新消息。系统初始至多 12 条种子消息，
// 在途消息总数受 MaxInFlight 约束（默认 12）。
//
// 检查器从初始配置出发按广度优先枚举所有可达配置，每一步可：
//   - 重排：交付任意一条当前已发送（在途）的消息；
//   - 重复：整条执行至多一次，让一条在途消息在不移除的情况下多交付一份；
//   - 崩溃：整条执行至多一个节点崩溃，崩溃节点不再接收消息。
//
// 若发现违反 Invariant 的配置，报告最短反例轨迹（Unsafe）；若状态空间
// 闭合且无反例，报告 Safe；若预算（深度或状态数）耗尽而空间未闭合，
// 报告 Unknown，从而把“未闭合预算”与“无反例”明确区分开。
// Check 发现的反例轨迹可作为证书，由 Replay 独立回放验收。
package pcheck

import (
	"errors"
	"fmt"
	"strings"
)

// MaxSeedMessages 是初始种子消息条数上限。
const MaxSeedMessages = 12

// DefaultMaxInFlight 是默认的在途消息容量上限。
const DefaultMaxInFlight = 12

// DefaultMaxStates 是默认的不同配置数预算。
const DefaultMaxStates = 100000

// Message 是一条已发送、尚未交付的消息。
type Message struct {
	From int
	To   int
	Kind string
}

func (m Message) String() string {
	return fmt.Sprintf("%d->%d:%s", m.From, m.To, m.Kind)
}

// Transition 描述节点在某状态下收到某类消息后的迁移：
// 进入 Next 状态，并发出 Sends 中的消息（From 字段会被覆盖为接收节点）。
type Transition struct {
	Next  string
	Sends []Message
}

// Table 是节点状态表：当前状态 -> 消息种类 -> 迁移。
// 表中不存在的（状态, 消息种类）组合视为丢弃该消息、状态不变。
type Table map[string]map[string]Transition

// ConfigView 是提供给安全性质判断的配置视图。
// 切片仅在回调期间有效，调用方不得保留或修改。
type ConfigView struct {
	States   []string
	InFlight []Message
	Alive    []bool
}

// Protocol 描述一个待检查的协议。
type Protocol struct {
	Nodes       int                       // 节点数，必须为正
	Initial     []string                  // 各节点初始状态，长度须等于 Nodes
	Tables      []Table                   // 各节点状态表，长度须等于 Nodes；nil 表示丢弃所有消息
	Seed        []Message                 // 初始已发送消息，至多 MaxSeedMessages 条
	MaxInFlight int                       // 在途消息容量；<=0 表示 DefaultMaxInFlight
	Invariant   func(cfg ConfigView) bool // 安全性质，对每个可达配置求值
}

// StepKind 是执行步骤的类型。
type StepKind int

const (
	StepDeliver   StepKind = iota // 交付一条在途消息并将其移除
	StepDuplicate                 // 交付一条在途消息的副本，原消息保留（整条执行至多一次）
	StepCrash                     // 使一个节点崩溃（整条执行至多一次）
)

// Step 是反例轨迹中的一步。Msg 是交付时在途消息的下标，Node 是崩溃节点。
type Step struct {
	Kind StepKind
	Msg  int
	Node int
}

func (s Step) String() string {
	switch s.Kind {
	case StepDeliver:
		return fmt.Sprintf("deliver#%d", s.Msg)
	case StepDuplicate:
		return fmt.Sprintf("duplicate#%d", s.Msg)
	case StepCrash:
		return fmt.Sprintf("crash(%d)", s.Node)
	}
	return fmt.Sprintf("step(%d)", int(s.Kind))
}

// Verdict 是检查结论。
type Verdict int

const (
	Safe    Verdict = iota // 状态空间闭合，无反例
	Unsafe                 // 发现安全反例（Trace 为最短轨迹）
	Unknown                // 预算耗尽，状态空间未闭合，无法定论
)

func (v Verdict) String() string {
	switch v {
	case Safe:
		return "Safe"
	case Unsafe:
		return "Unsafe"
	case Unknown:
		return "Unknown"
	}
	return fmt.Sprintf("Verdict(%d)", int(v))
}

// Budget 是探索预算。任一维度耗尽而空间未闭合时，结论为 Unknown。
type Budget struct {
	MaxDepth  int // 最大探索深度；<=0 表示不限
	MaxStates int // 最大不同配置数；<=0 表示 DefaultMaxStates
}

// Result 是 Check 的结果。
type Result struct {
	Verdict  Verdict
	Trace    []Step // Verdict 为 Unsafe 时的最短反例轨迹
	Explored int    // 探索过的不同配置数
	Depth    int    // 实际到达的最大深度
}

func (r Result) String() string {
	switch r.Verdict {
	case Unsafe:
		return fmt.Sprintf("Unsafe（最短反例 %d 步）: %v", len(r.Trace), r.Trace)
	case Safe:
		return fmt.Sprintf("Safe（闭合，探索 %d 个配置，深度 %d）", r.Explored, r.Depth)
	default:
		return fmt.Sprintf("Unknown（预算未闭合，探索 %d 个配置，深度 %d）", r.Explored, r.Depth)
	}
}

func (p *Protocol) validate() error {
	if p.Nodes <= 0 {
		return errors.New("pcheck: Nodes 必须为正")
	}
	if len(p.Initial) != p.Nodes {
		return fmt.Errorf("pcheck: Initial 长度 %d 与节点数 %d 不符", len(p.Initial), p.Nodes)
	}
	if len(p.Tables) != p.Nodes {
		return fmt.Errorf("pcheck: Tables 长度 %d 与节点数 %d 不符", len(p.Tables), p.Nodes)
	}
	if len(p.Seed) > MaxSeedMessages {
		return fmt.Errorf("pcheck: 种子消息 %d 条，超过上限 %d", len(p.Seed), MaxSeedMessages)
	}
	for i, m := range p.Seed {
		if m.From < 0 || m.From >= p.Nodes || m.To < 0 || m.To >= p.Nodes {
			return fmt.Errorf("pcheck: 种子消息 %d 的端点越界: %s", i, m)
		}
	}
	if p.Invariant == nil {
		return errors.New("pcheck: 缺少 Invariant")
	}
	return nil
}

func (p *Protocol) flightCap() int {
	if p.MaxInFlight <= 0 {
		return DefaultMaxInFlight
	}
	return p.MaxInFlight
}

// config 是探索过程中的完整系统配置。
type config struct {
	states    []string
	inFlight  []Message
	alive     []bool
	dupUsed   bool
	crashUsed bool
}

func (c *config) view() ConfigView {
	return ConfigView{States: c.states, InFlight: c.inFlight, Alive: c.alive}
}

func (c *config) clone() config {
	return config{
		states:    append([]string(nil), c.states...),
		inFlight:  append([]Message(nil), c.inFlight...),
		alive:     append([]bool(nil), c.alive...),
		dupUsed:   c.dupUsed,
		crashUsed: c.crashUsed,
	}
}

// key 返回配置的规范表示，用于去重。在途消息按顺序编码，保证健全。
func (c *config) key() string {
	var b strings.Builder
	b.WriteString(strings.Join(c.states, ","))
	b.WriteByte('|')
	for _, m := range c.inFlight {
		fmt.Fprintf(&b, "%d>%d:%s;", m.From, m.To, m.Kind)
	}
	b.WriteByte('|')
	for _, a := range c.alive {
		if a {
			b.WriteByte('1')
		} else {
			b.WriteByte('0')
		}
	}
	fmt.Fprintf(&b, "|%t|%t", c.dupUsed, c.crashUsed)
	return b.String()
}

func lookup(t Table, state, kind string) (Transition, bool) {
	byKind, ok := t[state]
	if !ok {
		return Transition{}, false
	}
	tr, ok := byKind[kind]
	return tr, ok
}

// deliver 返回交付在途消息 i 后的新配置。remove 为 false 时保留原消息
// （用于重复交付）。接收方已崩溃、发送目标越界或超出在途容量时返回 false。
func (c *config) deliver(p *Protocol, i int, remove bool) (config, bool) {
	m := c.inFlight[i]
	if !c.alive[m.To] {
		return config{}, false
	}
	next := c.clone()
	if remove {
		kept := make([]Message, 0, len(c.inFlight)-1)
		kept = append(kept, c.inFlight[:i]...)
		kept = append(kept, c.inFlight[i+1:]...)
		next.inFlight = kept
	}
	if tr, ok := lookup(p.Tables[m.To], c.states[m.To], m.Kind); ok {
		next.states[m.To] = tr.Next
		for _, s := range tr.Sends {
			if s.To < 0 || s.To >= p.Nodes {
				return config{}, false
			}
			s.From = m.To
			next.inFlight = append(next.inFlight, s)
		}
	}
	if len(next.inFlight) > p.flightCap() {
		return config{}, false
	}
	return next, true
}

// crash 返回使节点 n 崩溃后的新配置。
func (c *config) crash(n int) (config, bool) {
	if c.crashUsed || n < 0 || n >= len(c.alive) || !c.alive[n] {
		return config{}, false
	}
	next := c.clone()
	next.alive[n] = false
	next.crashUsed = true
	return next, true
}

type successor struct {
	step Step
	cfg  config
}

// successors 枚举配置的所有后继：交付任意在途消息（重排）、
// 至多一次重复交付、至多一次节点崩溃。
func successors(p *Protocol, c *config) []successor {
	var out []successor
	for i, m := range c.inFlight {
		if !c.alive[m.To] {
			continue
		}
		if nc, ok := c.deliver(p, i, true); ok {
			out = append(out, successor{step: Step{Kind: StepDeliver, Msg: i}, cfg: nc})
		}
	}
	if !c.dupUsed {
		for i, m := range c.inFlight {
			if !c.alive[m.To] {
				continue
			}
			if nc, ok := c.deliver(p, i, false); ok {
				nc.dupUsed = true
				out = append(out, successor{step: Step{Kind: StepDuplicate, Msg: i}, cfg: nc})
			}
		}
	}
	if !c.crashUsed {
		for n := 0; n < p.Nodes; n++ {
			if nc, ok := c.crash(n); ok {
				out = append(out, successor{step: Step{Kind: StepCrash, Node: n}, cfg: nc})
			}
		}
	}
	return out
}

func (p *Protocol) initial() config {
	c := config{
		states:   append([]string(nil), p.Initial...),
		inFlight: append([]Message(nil), p.Seed...),
		alive:    make([]bool, p.Nodes),
	}
	for i := range c.alive {
		c.alive[i] = true
	}
	return c
}

// node 是 BFS 搜索树节点，通过父指针回溯轨迹。
type node struct {
	cfg    config
	parent *node
	step   Step
	depth  int
}

func traceOf(n *node) []Step {
	var rev []Step
	for cur := n; cur.parent != nil; cur = cur.parent {
		rev = append(rev, cur.step)
	}
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	return rev
}

// Check 对协议做有界安全性检查，报告最短反例。
// 预算耗尽而空间未闭合时返回 Unknown，与闭合无反例的 Safe 明确区分。
func Check(p *Protocol, b Budget) (Result, error) {
	if err := p.validate(); err != nil {
		return Result{}, err
	}
	start := p.initial()
	if !p.Invariant(start.view()) {
		return Result{Verdict: Unsafe, Trace: []Step{}}, nil
	}
	maxStates := b.MaxStates
	if maxStates <= 0 {
		maxStates = DefaultMaxStates
	}
	visited := map[string]struct{}{start.key(): {}}
	queue := []*node{{cfg: start}}
	truncated := false
	res := Result{Verdict: Safe}
	for len(queue) > 0 {
		if len(visited) >= maxStates {
			truncated = true
			break
		}
		cur := queue[0]
		queue = queue[1:]
		if cur.depth > res.Depth {
			res.Depth = cur.depth
		}
		succs := successors(p, &cur.cfg)
		if b.MaxDepth > 0 && cur.depth >= b.MaxDepth {
			if len(succs) > 0 {
				truncated = true
			}
			continue
		}
		for _, s := range succs {
			if !p.Invariant(s.cfg.view()) {
				bad := &node{cfg: s.cfg, parent: cur, step: s.step, depth: cur.depth + 1}
				res.Verdict = Unsafe
				res.Trace = traceOf(bad)
				res.Explored = len(visited)
				return res, nil
			}
			k := s.cfg.key()
			if _, seen := visited[k]; seen {
				continue
			}
			visited[k] = struct{}{}
			queue = append(queue, &node{cfg: s.cfg, parent: cur, step: s.step, depth: cur.depth + 1})
		}
	}
	res.Explored = len(visited)
	if truncated || len(queue) > 0 {
		res.Verdict = Unknown
	}
	return res, nil
}
