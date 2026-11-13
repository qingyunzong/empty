package dataeng

import "time"

// Version 是维度在某键上的一个有效版本，事件时间区间为闭开区间 [Start, End)。
type Version struct {
	Key   string
	Start time.Time
	End   time.Time
}

// Contains 报告事件时间 t 是否落在版本的闭开区间 [Start, End) 内。
func (v Version) Contains(t time.Time) bool {
	return !t.Before(v.Start) && t.Before(v.End)
}

// Overlaps 报告两个同键版本的闭开区间是否重叠。
func (v Version) Overlaps(o Version) bool {
	return v.Key == o.Key && v.Start.Before(o.End) && o.Start.Before(v.End)
}

// Fact 是采集流水线已发布的一条事实。
type Fact struct {
	Key       string
	EventTime time.Time
	Value     string
}

// Correction 描述迟到版本到达后对已发布事实的改正：
// Retract 是需要撤回的已发布事实，Interval 是交给调用方修正的区间。
type Correction struct {
	Late     Version
	Retract  []Fact
	Interval Version
}
