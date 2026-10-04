// Package handshake 模拟基于挑战 ID 的握手流程：
// 回应、超时与撤销事件按挑战 ID 分发，同 ID 的回应必须与签发时
// 绑定的摘要匹配；同一 tick 内的事件严格按输入顺序处理；
// 终态（已验证/已超时/已撤销）持久且不可被后续事件覆盖。
package handshake

import (
	"errors"
	"fmt"
	"sync"
)

// State 表示挑战所处的有限状态。
type State int

const (
	StatePending State = iota
	StateVerified
	StateTimedOut
	StateRevoked
)

func (s State) String() string {
	switch s {
	case StatePending:
		return "pending"
	case StateVerified:
		return "verified"
	case StateTimedOut:
		return "timed_out"
	case StateRevoked:
		return "revoked"
	}
	return "unknown"
}

// Terminal 报告状态是否为终态。终态持久，不可被任何事件覆盖。
func (s State) Terminal() bool {
	return s == StateVerified || s == StateTimedOut || s == StateRevoked
}

// EventKind 区分输入事件的类型。
type EventKind int

const (
	EventRespond EventKind = iota
	EventTimeout
	EventRevoke
)

func (k EventKind) String() string {
	switch k {
	case EventRespond:
		return "respond"
	case EventTimeout:
		return "timeout"
	case EventRevoke:
		return "revoke"
	}
	return "unknown"
}

// transitions 是有限状态表：仅 Pending 存在出边，终态无任何出边。
var transitions = map[State]map[EventKind]State{
	StatePending: {
		EventRespond: StateVerified,
		EventTimeout: StateTimedOut,
		EventRevoke:  StateRevoked,
	},
	StateVerified: {},
	StateTimedOut: {},
	StateRevoked:  {},
}

// Next 查询状态表，返回 (下一状态, 迁移是否合法)。
func Next(s State, k EventKind) (State, bool) {
	next, ok := transitions[s][k]
	return next, ok
}

// Event 是同一 tick 内按输入顺序处理的一条输入。
type Event struct {
	Kind   EventKind
	ID     string
	Digest string // 仅 EventRespond 使用
}

// Outcome 描述单条事件的处理结果。
type Outcome int

const (
	OutcomeApplied Outcome = iota
	OutcomeDigestMismatch
	OutcomeIgnoredTerminal
	OutcomeUnknownChallenge
)

func (o Outcome) String() string {
	switch o {
	case OutcomeApplied:
		return "applied"
	case OutcomeDigestMismatch:
		return "digest_mismatch"
	case OutcomeIgnoredTerminal:
		return "ignored_terminal"
	case OutcomeUnknownChallenge:
		return "unknown_challenge"
	}
	return "unknown"
}

// Record 记录一条事件的处理轨迹，便于核对乱序/重复事件。
type Record struct {
	Seq     int
	Event   Event
	Outcome Outcome
	State   State // 事件处理后的状态；未知挑战时为 StatePending 占位
}

var (
	ErrEmptyID         = errors.New("handshake: empty challenge id")
	ErrDuplicateIssue  = errors.New("handshake: challenge id already issued")
	ErrTerminalPersist = errors.New("handshake: terminal state persists, cannot re-issue")
)

type challenge struct {
	digest string
	state  State
}

// Simulator 按挑战 ID 维护握手状态机。
type Simulator struct {
	mu         sync.Mutex
	challenges map[string]*challenge
	log        []Record
}

func New() *Simulator {
	return &Simulator{challenges: make(map[string]*challenge)}
}

// Issue 签发挑战，将 ID 与摘要绑定，初始状态为 Pending。
// 已存在的 ID（无论是否终态）都不可被覆盖。
func (s *Simulator) Issue(id, digest string) error {
	if id == "" {
		return ErrEmptyID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.challenges[id]; ok {
		if c.state.Terminal() {
			return fmt.Errorf("%w: id=%q state=%s", ErrTerminalPersist, id, c.state)
		}
		return fmt.Errorf("%w: id=%q", ErrDuplicateIssue, id)
	}
	s.challenges[id] = &challenge{digest: digest, state: StatePending}
	return nil
}

// Apply 在同一 tick 内严格按输入顺序处理事件，返回与输入等长的结果。
func (s *Simulator) Apply(events ...Event) []Outcome {
	s.mu.Lock()
	defer s.mu.Unlock()
	outcomes := make([]Outcome, len(events))
	for i, ev := range events {
		outcomes[i] = s.applyLocked(ev)
	}
	return outcomes
}

func (s *Simulator) applyLocked(ev Event) Outcome {
	c, ok := s.challenges[ev.ID]
	if !ok {
		s.log = append(s.log, Record{Seq: len(s.log), Event: ev, Outcome: OutcomeUnknownChallenge})
		return OutcomeUnknownChallenge
	}
	if c.state.Terminal() {
		s.log = append(s.log, Record{Seq: len(s.log), Event: ev, Outcome: OutcomeIgnoredTerminal, State: c.state})
		return OutcomeIgnoredTerminal
	}
	next, ok := Next(c.state, ev.Kind)
	if !ok {
		s.log = append(s.log, Record{Seq: len(s.log), Event: ev, Outcome: OutcomeIgnoredTerminal, State: c.state})
		return OutcomeIgnoredTerminal
	}
	if ev.Kind == EventRespond && ev.Digest != c.digest {
		s.log = append(s.log, Record{Seq: len(s.log), Event: ev, Outcome: OutcomeDigestMismatch, State: c.state})
		return OutcomeDigestMismatch
	}
	c.state = next
	s.log = append(s.log, Record{Seq: len(s.log), Event: ev, Outcome: OutcomeApplied, State: c.state})
	return OutcomeApplied
}

// State 查询指定挑战 ID 的当前状态。
func (s *Simulator) State(id string) (State, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.challenges[id]
	if !ok {
		return StatePending, false
	}
	return c.state, true
}

// Log 返回处理轨迹的副本。
func (s *Simulator) Log() []Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Record, len(s.log))
	copy(out, s.log)
	return out
}
