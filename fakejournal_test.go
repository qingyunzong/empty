package dataeng

import (
	"errors"
	"fmt"
	"io"
	"sort"
	"testing"
)

// fakeJournal 是 Reader 的内存实现，模拟 sdjournal 的 seek/next 语义，
// 并支持通过 vacuum 删除头部条目来复现游标失效。
type fakeJournal struct {
	entries []*Entry
	alive   map[string]int // cursor -> 当前下标
	pos     int
}

func newFakeJournal(entries []*Entry) *fakeJournal {
	f := &fakeJournal{alive: make(map[string]int, len(entries)), pos: -1}
	for i, e := range entries {
		if e.Cursor == "" {
			e.Cursor = fmt.Sprintf("s=seq;i=%x;b=%s", i, e.BootID)
		}
		if e.Fields == nil {
			e.Fields = map[string]string{}
		}
		f.alive[e.Cursor] = i
	}
	f.entries = entries
	return f
}

// vacuum 删除前 n 条条目，模拟 journal 文件被清理。
func (f *fakeJournal) vacuum(n int) {
	if n > len(f.entries) {
		n = len(f.entries)
	}
	for _, e := range f.entries[:n] {
		delete(f.alive, e.Cursor)
	}
	f.entries = append([]*Entry(nil), f.entries[n:]...)
	f.alive = make(map[string]int, len(f.entries))
	for i, e := range f.entries {
		f.alive[e.Cursor] = i
	}
	f.pos = -1
}

func (f *fakeJournal) SeekCursor(cursor string) error {
	if i, ok := f.alive[cursor]; ok {
		f.pos = i - 1
		return nil
	}
	// 游标已失效：与 sd_journal_seek_cursor 一样落到邻近位置，
	// 这里取剩余条目的开头，由 ValidateCursor 复核发现不一致。
	f.pos = -1
	return nil
}

func (f *fakeJournal) SeekRealtime(usec uint64) error {
	i := sort.Search(len(f.entries), func(i int) bool {
		return f.entries[i].Realtime >= usec
	})
	f.pos = i - 1
	return nil
}

func (f *fakeJournal) SeekHead() error {
	f.pos = -1
	return nil
}

func (f *fakeJournal) SeekTail() error {
	f.pos = len(f.entries)
	return nil
}

func (f *fakeJournal) Next() (bool, error) {
	if f.pos+1 >= len(f.entries) {
		f.pos = len(f.entries)
		return false, nil
	}
	f.pos++
	return true, nil
}

func (f *fakeJournal) Cursor() (string, error) {
	if f.pos < 0 || f.pos >= len(f.entries) {
		return "", ErrNoEntry
	}
	return f.entries[f.pos].Cursor, nil
}

func (f *fakeJournal) Entry() (*Entry, error) {
	if f.pos < 0 || f.pos >= len(f.entries) {
		return nil, ErrNoEntry
	}
	return f.entries[f.pos], nil
}

// drain 读尽连接器剩余条目。
func drain(tb testing.TB, c *Connector) []*Entry {
	tb.Helper()
	var out []*Entry
	for {
		e, err := c.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			tb.Fatalf("next: %v", err)
		}
		out = append(out, e)
	}
}

func messages(entries []*Entry) []string {
	out := make([]string, len(entries))
	for i, e := range entries {
		out[i] = e.Fields["MESSAGE"]
	}
	return out
}

func entry(boot string, realtime, monotonic uint64, msg string) *Entry {
	return &Entry{
		BootID:    boot,
		Realtime:  realtime,
		Monotonic: monotonic,
		Fields:    map[string]string{"MESSAGE": msg},
	}
}
