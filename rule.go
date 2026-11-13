package dataeng

import "context"

// DepFailurePolicy 决定当前置规则未通过（失败或被跳过）时本规则的行为。
type DepFailurePolicy int

const (
	// SkipOnDepFailure 前置未通过时跳过本规则（默认）。
	SkipOnDepFailure DepFailurePolicy = iota
	// ContinueOnDepFailure 前置未通过时仍然执行本规则。
	ContinueOnDepFailure
)

// Rule 声明一条质量规则：输入列、前置规则与产生的派生列。
type Rule struct {
	// ID 规则唯一标识。
	ID string
	// Inputs 规则读取的输入列，必须来自基础列或其他规则的派生列。
	Inputs []string
	// DependsOn 前置规则 ID 列表，决定执行顺序。
	DependsOn []string
	// Produces 规则成功后产生的派生列。
	Produces []string
	// OnDepFailure 前置规则未通过时的策略，默认为 SkipOnDepFailure。
	OnDepFailure DepFailurePolicy
	// Run 规则执行体，返回 nil 表示通过，非 nil 表示失败。
	Run func(ctx context.Context) error
}

// Status 是规则的最终执行状态。被跳过的规则绝不能被当作通过。
type Status int

const (
	// StatusPassed 规则执行并通过。
	StatusPassed Status = iota
	// StatusFailed 规则执行但未通过。
	StatusFailed
	// StatusSkipped 规则因前置未通过且策略为 Skip 而未执行。
	StatusSkipped
)

func (s Status) String() string {
	switch s {
	case StatusPassed:
		return "passed"
	case StatusFailed:
		return "failed"
	case StatusSkipped:
		return "skipped"
	default:
		return "unknown"
	}
}

// Result 是单条规则的执行结果。
type Result struct {
	RuleID   string
	Status   Status
	Err      error
	Produces []string
}
