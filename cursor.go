package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
)

// State 描述主机日志连接器在 journal 中的消费位置。
//
// Cursor 是 journald 分配的游标字符串，可直接用于 seek；
// BootID / Realtime / Monotonic 是游标对应条目的时间戳三元组，
// 用于 cursor 失效（例如 journal vacuum 清理了旧条目）后的时间补扫。
//
// 注意：Monotonic 仅在同一 BootID 内可比较，跨 boot 比较单调时间没有意义。
type State struct {
	Cursor    string `json:"cursor,omitempty"`
	BootID    string `json:"boot_id,omitempty"`
	Realtime  uint64 `json:"realtime,omitempty"`  // CLOCK_REALTIME，微秒
	Monotonic uint64 `json:"monotonic,omitempty"` // CLOCK_MONOTONIC，微秒，仅同 boot 可比
}

// IsZero 报告状态是否为空（从未消费过任何条目）。
func (s State) IsZero() bool {
	return s.Cursor == "" && s.BootID == "" && s.Realtime == 0 && s.Monotonic == 0
}

// Validate 校验状态是否自洽：
// 只要状态非空，就必须带有可用于补扫的 realtime 时间戳。
func (s State) Validate() error {
	if s.IsZero() {
		return nil
	}
	if s.Cursor == "" {
		return errors.New("dataeng: state missing cursor")
	}
	if s.Realtime == 0 {
		return errors.New("dataeng: state missing realtime timestamp")
	}
	return nil
}

// Marshal 将状态序列化为 JSON，便于连接器持久化。
func (s State) Marshal() ([]byte, error) {
	return json.Marshal(s)
}

// ParseState 从 JSON 还原状态并做自洽校验。
func ParseState(data []byte) (State, error) {
	var s State
	if len(data) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(data, &s); err != nil {
		return State{}, fmt.Errorf("dataeng: parse state: %w", err)
	}
	if err := s.Validate(); err != nil {
		return State{}, err
	}
	return s, nil
}

// stateFromEntry 用条目当前位置生成新的消费状态。
func stateFromEntry(e *Entry) State {
	return State{
		Cursor:    e.Cursor,
		BootID:    e.BootID,
		Realtime:  e.Realtime,
		Monotonic: e.Monotonic,
	}
}

// coveredByState 报告条目 e 是否一定不晚于状态 st（即恢复时无需再次投递）。
//
// 时间比较规则：
//   - realtime 不同：直接按 realtime 比较（跨 boot 也可比）；
//   - realtime 相同且同 boot：按 monotonic 比较；
//   - realtime 相同但跨 boot：单调时间不可比，无法证明已被覆盖，
//     返回 false，交给去重窗口裁决。
func coveredByState(st State, e *Entry) bool {
	if e.Realtime != st.Realtime {
		return e.Realtime < st.Realtime
	}
	if e.BootID != st.BootID {
		return false
	}
	return e.Monotonic <= st.Monotonic
}
