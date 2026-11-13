package dataeng

import (
	"strconv"
	"strings"
)

// DefaultUniqueFields 是补扫去重默认使用的唯一字段集：
// boot id + realtime + monotonic 三元组在同一 journal 中唯一标识一条目。
var DefaultUniqueFields = []string{
	"_BOOT_ID",
	"__REALTIME_TIMESTAMP",
	"__MONOTONIC_TIMESTAMP",
}

// Deduper 按唯一字段集对条目去重。
//
// 补扫（backfill）按时间重新读取区间时会与已投递条目重叠，
// Deduper 用一个有界 FIFO 窗口记住最近见过的条目键，重叠部分直接丢弃。
// 窗口容量决定了可吸收的重叠规模；超出窗口的旧键被淘汰后，
// 对应条目若再次被读到会视为新条目。
type Deduper struct {
	fields   []string
	capacity int
	seen     map[string]struct{}
	order    []string
}

// NewDeduper 创建去重器。capacity <= 0 时取 4096；
// fields 为空时使用 DefaultUniqueFields。
func NewDeduper(capacity int, fields ...string) *Deduper {
	if capacity <= 0 {
		capacity = 4096
	}
	if len(fields) == 0 {
		fields = DefaultUniqueFields
	}
	return &Deduper{
		fields:   fields,
		capacity: capacity,
		seen:     make(map[string]struct{}, capacity),
	}
}

// Key 按唯一字段集计算条目键。
//
// 可信时间戳字段取自 Entry 的类型化字段，其余字段取自 Fields；
// 缺失字段以空串占位，保证键的字段布局稳定。
func (d *Deduper) Key(e *Entry) string {
	var b strings.Builder
	for i, f := range d.fields {
		if i > 0 {
			b.WriteByte(0)
		}
		switch f {
		case "_BOOT_ID":
			b.WriteString(e.BootID)
		case "__REALTIME_TIMESTAMP":
			b.WriteString(strconv.FormatUint(e.Realtime, 10))
		case "__MONOTONIC_TIMESTAMP":
			b.WriteString(strconv.FormatUint(e.Monotonic, 10))
		default:
			b.WriteString(e.Fields[f])
		}
	}
	return b.String()
}

// Seen 报告条目是否已在窗口中；未见过则记录并返回 false。
func (d *Deduper) Seen(e *Entry) bool {
	k := d.Key(e)
	if _, ok := d.seen[k]; ok {
		return true
	}
	d.seen[k] = struct{}{}
	d.order = append(d.order, k)
	if len(d.order) > d.capacity {
		delete(d.seen, d.order[0])
		d.order = d.order[1:]
	}
	return false
}

// Len 返回当前窗口内记住的键数量，主要用于测试与监控。
func (d *Deduper) Len() int {
	return len(d.seen)
}
