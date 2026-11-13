package dataeng

import "errors"

// Kind 标识馈送项是更改还是删除。
type Kind int

const (
	KindChange Kind = iota
	KindDelete
)

// DeleteReason 只允许 removed 或 changed。
type DeleteReason string

const (
	ReasonRemoved DeleteReason = "removed"
	ReasonChanged DeleteReason = "changed"
)

var (
	ErrUnknownKind      = errors.New("dataeng: unknown event kind")
	ErrBadDeleteReason  = errors.New("dataeng: delete reason must be removed or changed")
	ErrConflictingLinks = errors.New("dataeng: next link and delta link must not both be set")
)

// Event 是馈送中的一项：不是更改就是删除。
type Event struct {
	Kind   Kind
	Key    string
	Value  string
	Reason DeleteReason // 仅删除项使用
}

// Page 是一页馈送结果，下一链接与增量链接互斥。
type Page struct {
	Events    []Event
	NextLink  string
	DeltaLink string
}

// Validate 校验页面链接：两种链接同时存在则失败。
func (p Page) Validate() error {
	if p.NextLink != "" && p.DeltaLink != "" {
		return ErrConflictingLinks
	}
	return nil
}

// View 是应用馈送后的当前视图，含墓碑记录。
type View struct {
	items      map[string]string
	tombstones map[string]bool
}

func NewView() *View {
	return &View{
		items:      make(map[string]string),
		tombstones: make(map[string]bool),
	}
}

// Apply 按序应用单个事件，同一键后到的事件覆盖先到的。
func (v *View) Apply(ev Event) error {
	switch ev.Kind {
	case KindChange:
		v.items[ev.Key] = ev.Value
		delete(v.tombstones, ev.Key)
		return nil
	case KindDelete:
		switch ev.Reason {
		case ReasonRemoved:
			delete(v.items, ev.Key)
			v.tombstones[ev.Key] = true
			return nil
		case ReasonChanged:
			delete(v.items, ev.Key)
			return nil
		default:
			return ErrBadDeleteReason
		}
	default:
		return ErrUnknownKind
	}
}

// ApplyPage 校验页面链接后按序应用整页事件。
func (v *View) ApplyPage(p Page) error {
	if err := p.Validate(); err != nil {
		return err
	}
	for _, ev := range p.Events {
		if err := v.Apply(ev); err != nil {
			return err
		}
	}
	return nil
}

// Get 返回键在当前视图中的值。
func (v *View) Get(key string) (string, bool) {
	val, ok := v.items[key]
	return val, ok
}

// Tombstoned 报告键是否留有 removed 墓碑。
func (v *View) Tombstoned(key string) bool {
	return v.tombstones[key]
}

// Len 返回当前视图中的键数。
func (v *View) Len() int {
	return len(v.items)
}
