package auditlog

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const testSecret = "AKIA-SECRET-KEY-12345"

func newTestLogger(t *testing.T) (*Logger, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "audit.log")
	l, err := OpenLogger(path)
	if err != nil {
		t.Fatalf("OpenLogger: %v", err)
	}
	return l, path
}

// 记录必须包含原载荷摘要、脱敏载荷与范围清单；
// 脱敏后链摘要必须可仅凭记录数据重放验证。
func TestRecordFieldsAndChainReplay(t *testing.T) {
	l, path := newTestLogger(t)
	payloads := [][]byte{
		[]byte("req1 key=" + testSecret + " ok"),
		[]byte("req2 token=" + testSecret + " done"),
		[]byte("req3 no-secret-here"),
	}
	ranges := [][]Range{
		{{Start: 9, End: 9 + len(testSecret)}},
		{{Start: 11, End: 11 + len(testSecret)}},
		nil,
	}
	for i, p := range payloads {
		if _, err := l.Log(p, ranges[i]); err != nil {
			t.Fatalf("Log %d: %v", i, err)
		}
	}
	l.Close()

	// 重新打开：恢复 + 重放链摘要。
	l2, err := OpenLogger(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer l2.Close()
	records, err := l2.Records()
	if err != nil {
		t.Fatalf("Records: %v", err)
	}
	if len(records) != len(payloads) {
		t.Fatalf("got %d records, want %d", len(records), len(payloads))
	}
	for i, rec := range records {
		if len(rec.Redacted) != len(payloads[i]) {
			t.Fatalf("record %d redacted length changed", i)
		}
		if rec.PayloadHash == ZeroDigest {
			t.Fatalf("record %d missing original payload digest", i)
		}
		if rec.Hash == ZeroDigest {
			t.Fatalf("record %d missing chain hash", i)
		}
	}
	if len(records[0].Ranges) != 1 || len(records[2].Ranges) != 0 {
		t.Fatalf("range lists not preserved: %+v / %+v", records[0].Ranges, records[2].Ranges)
	}
	if err := VerifyChain(records); err != nil {
		t.Fatalf("chain replay after reopen: %v", err)
	}
}

// 原秘密绝不写入任何输出：记录 JSON 与磁盘文件都不得包含秘密字节。
func TestSecretNeverWrittenToOutput(t *testing.T) {
	l, path := newTestLogger(t)
	payload := []byte("login user=bob pass=" + testSecret + " end")
	rec, err := l.Log(payload, []Range{{Start: 20, End: 20 + len(testSecret)}})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	l.Close()

	if bytes.Contains(rec.Redacted, []byte(testSecret)) {
		t.Fatal("secret present in redacted payload")
	}
	encoded, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if bytes.Contains(encoded, []byte(testSecret)) {
		t.Fatal("secret present in serialized record")
	}
	onDisk, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	if bytes.Contains(onDisk, []byte(testSecret)) {
		t.Fatal("secret present in on-disk log")
	}
}

// 篡改脱敏载荷或范围清单后，链重放必须失败。
func TestChainDetectsTampering(t *testing.T) {
	l, _ := newTestLogger(t)
	if _, err := l.Log([]byte("aaa secret bbb"), []Range{{4, 10}}); err != nil {
		t.Fatalf("Log: %v", err)
	}
	if _, err := l.Log([]byte("ccc plain ddd"), nil); err != nil {
		t.Fatalf("Log: %v", err)
	}
	records, err := l.Records()
	if err != nil {
		t.Fatalf("Records: %v", err)
	}
	l.Close()
	tamper := func(mutate func(*Record)) {
		cp := make([]*Record, len(records))
		for i, r := range records {
			c := *r
			c.Redacted = append([]byte(nil), r.Redacted...)
			c.Ranges = append([]Range(nil), r.Ranges...)
			cp[i] = &c
		}
		mutate(cp[0])
		if err := VerifyChain(cp); !errors.Is(err, ErrChainBroken) {
			t.Fatalf("VerifyChain err = %v, want ErrChainBroken", err)
		}
	}
	tamper(func(r *Record) { r.Redacted[0] ^= 0xFF })    // 改脱敏载荷
	tamper(func(r *Record) { r.Ranges[0].End++ })        // 改范围清单
	tamper(func(r *Record) { r.PayloadHash[0] ^= 0xFF }) // 改原载荷摘要
	tamper(func(r *Record) { r.Seq = 7 })                // 改序号
}
