package resourceblock

import (
	"errors"
	"fmt"
	"strings"
)

// 受控回调验收：非法登记会被拒绝。
var (
	// ErrNilCleanup 表示登记了 nil 清理回调。
	ErrNilCleanup = errors.New("resourceblock: nil cleanup callback")
	// ErrScopeClosed 表示资源块已退出，拒绝再登记资源。
	ErrScopeClosed = errors.New("resourceblock: scope is closed")
)

// ExitError 在资源块退出时保留主错误（Primary），并附上清理阶段产生的
// 从错误（Cleanup）。Primary 可能为 nil（仅清理失败的情形）。
type ExitError struct {
	Primary error
	Cleanup []error
}

func (e *ExitError) Error() string {
	var b strings.Builder
	if e.Primary != nil {
		b.WriteString(e.Primary.Error())
	} else {
		b.WriteString("resourceblock: block exited")
	}
	fmt.Fprintf(&b, " (%d cleanup failure(s)", len(e.Cleanup))
	for _, err := range e.Cleanup {
		b.WriteString("; ")
		b.WriteString(err.Error())
	}
	b.WriteString(")")
	return b.String()
}

// Unwrap 同时暴露主错误与全部从错误，errors.Is/As 对任一错误均生效。
func (e *ExitError) Unwrap() []error {
	all := make([]error, 0, len(e.Cleanup)+1)
	if e.Primary != nil {
		all = append(all, e.Primary)
	}
	return append(all, e.Cleanup...)
}
