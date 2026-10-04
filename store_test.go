package auditlog

import (
	"os"
	"path/filepath"
	"testing"
)

// 模拟断电：在完好记录之后留下撕裂的尾部帧，
// 重新打开必须截断撕裂部分、保留全部完好记录，且链可重放、可继续追加。
func TestPowerLossRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := OpenLogger(path)
	if err != nil {
		t.Fatalf("OpenLogger: %v", err)
	}
	for i := 0; i < 3; i++ {
		if _, err := l.Log([]byte("payload-"+string(rune('a'+i))), []Range{{0, 3}}); err != nil {
			t.Fatalf("Log %d: %v", i, err)
		}
	}
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	goodSize := st.Size()

	// 场景 1：帧写到一半断电（撕裂尾部）。
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		t.Fatalf("open for append: %v", err)
	}
	if _, err := f.Write([]byte{0x41, 0x55, 0x44, 0x31, 0x00, 0x00, 0x01, 0x00, '{', '"'}); err != nil {
		t.Fatalf("write torn frame: %v", err)
	}
	f.Close()

	l2, err := OpenLogger(path)
	if err != nil {
		t.Fatalf("reopen after power loss: %v", err)
	}
	records, err := l2.Records()
	if err != nil {
		t.Fatalf("Records: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("got %d records after recovery, want 3", len(records))
	}
	if err := VerifyChain(records); err != nil {
		t.Fatalf("chain replay after recovery: %v", err)
	}
	// 撕裂尾部已被截断。
	if st, _ := os.Stat(path); st.Size() != goodSize {
		t.Fatalf("file size = %d, want truncated to %d", st.Size(), goodSize)
	}
	// 恢复后可以继续追加，且序号/链延续正确。
	rec, err := l2.Log([]byte("after-recovery"), nil)
	if err != nil {
		t.Fatalf("Log after recovery: %v", err)
	}
	if rec.Seq != 3 || rec.PrevHash != records[2].Hash {
		t.Fatalf("chain not continued: seq=%d", rec.Seq)
	}
	l2.Close()

	// 场景 2：尾部被写入垃圾字节（坏 magic）。
	f, _ = os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	f.Write([]byte{0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02})
	f.Close()
	l3, err := OpenLogger(path)
	if err != nil {
		t.Fatalf("reopen after garbage tail: %v", err)
	}
	records, err = l3.Records()
	if err != nil {
		t.Fatalf("Records: %v", err)
	}
	if len(records) != 4 {
		t.Fatalf("got %d records, want 4", len(records))
	}
	if err := VerifyChain(records); err != nil {
		t.Fatalf("chain replay: %v", err)
	}
	l3.Close()
}

// 篡改文件中的记录字节（CRC 仍匹配不上）时，恢复应截断到篡改点之前。
func TestCorruptedFrameTruncated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := OpenLogger(path)
	if err != nil {
		t.Fatalf("OpenLogger: %v", err)
	}
	l.Log([]byte("first"), nil)
	l.Log([]byte("second"), nil)
	l.Close()

	// 破坏第二条记录载荷中的一个字节（CRC 校验将失败）。
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	data[len(data)-8] ^= 0xFF
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	l2, err := OpenLogger(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer l2.Close()
	records, err := l2.Records()
	if err != nil {
		t.Fatalf("Records: %v", err)
	}
	if len(records) != 1 {
		t.Fatalf("got %d records, want 1 (corrupted tail truncated)", len(records))
	}
	if err := VerifyChain(records); err != nil {
		t.Fatalf("chain replay: %v", err)
	}
}
