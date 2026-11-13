package dataeng

import "errors"

// Entry 是一条 journal 日志条目。
//
// Cursor / BootID / Realtime / Monotonic 对应 journald 的可信字段
// （__CURSOR、_BOOT_ID、__REALTIME_TIMESTAMP、__MONOTONIC_TIMESTAMP），
// Fields 保存其余业务字段（MESSAGE、SYSLOG_IDENTIFIER 等）。
type Entry struct {
	Cursor    string
	BootID    string
	Realtime  uint64
	Monotonic uint64
	Fields    map[string]string
}

// Reader 抽象 sdjournal 的读取能力，便于连接器直接接入
// go-systemd sdjournal，也便于用内存实现做测试。
//
// 语义对齐 sd_journal 系列 API：
//   - Seek* 只定位，不消费；定位后需调用 Next 移到条目上；
//   - Next 返回 false 表示已读到当前末尾；
//   - Cursor / Entry 返回当前位置（最近一次 Next 命中的条目）。
type Reader interface {
	// SeekCursor 定位到指定游标处；游标已失效（如被 vacuum 清理）
	// 时定位到其后的最近条目，因此调用方必须用 ValidateCursor 复核。
	SeekCursor(cursor string) error
	// SeekRealtime 定位到 realtime（微秒）不早于给定值的第一条目。
	SeekRealtime(usec uint64) error
	// SeekHead 定位到 journal 开头。
	SeekHead() error
	// SeekTail 定位到 journal 末尾（只读之后新写入的条目）。
	SeekTail() error
	// Next 前进到下一条目；到达末尾返回 (false, nil)。
	Next() (bool, error)
	// Cursor 返回当前条目的游标字符串。
	Cursor() (string, error)
	// Entry 返回当前条目。
	Entry() (*Entry, error)
}

// ErrNoEntry 表示 Reader 尚未定位到任何条目。
var ErrNoEntry = errors.New("dataeng: reader not positioned on an entry")

// ValidateCursor 验证游标是否仍指向 journal 中的真实条目。
//
// journal vacuum 清理旧文件后，历史 cursor 会失效：此时 SeekCursor
// 不会报错，而是落到邻近条目上，因此必须 seek 后取回实际游标逐一比对。
// 验证成功后 Reader 停留在该游标对应条目上，调用方继续 Next 即可
// 读到其后的条目。
func ValidateCursor(r Reader, cursor string) (bool, error) {
	if cursor == "" {
		return false, nil
	}
	if err := r.SeekCursor(cursor); err != nil {
		return false, err
	}
	ok, err := r.Next()
	if err != nil || !ok {
		return false, err
	}
	got, err := r.Cursor()
	if err != nil {
		return false, err
	}
	return got == cursor, nil
}
