package resourceblock

import "fmt"

// EventKind 标识资源块生命周期中发生的事件类型。
type EventKind int

const (
	// EventAcquire 表示一个资源被登记（其清理回调进入清理栈）。
	EventAcquire EventKind = iota
	// EventRelease 表示一个资源的清理回调成功执行。
	EventRelease
	// EventReleaseFailed 表示一个资源的清理回调执行失败（含 panic）。
	EventReleaseFailed
)

func (k EventKind) String() string {
	switch k {
	case EventAcquire:
		return "acquire"
	case EventRelease:
		return "release"
	case EventReleaseFailed:
		return "release-failed"
	default:
		return "unknown"
	}
}

// Event 是资源块输出的事件轨迹中的一条记录。
type Event struct {
	Seq  int       // 块内单调递增序号
	Kind EventKind // 事件类型
	Name string    // 资源名
	Err  error     // 仅 EventReleaseFailed 时非空
}

func (e Event) String() string {
	if e.Err != nil {
		return fmt.Sprintf("#%d %s %q: %v", e.Seq, e.Kind, e.Name, e.Err)
	}
	return fmt.Sprintf("#%d %s %q", e.Seq, e.Kind, e.Name)
}
