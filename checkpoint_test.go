package dataeng_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

func collect(t *testing.T, data []byte, opts dataeng.Options) ([]gotRecord, *dataeng.Reader, error) {
	t.Helper()
	var got []gotRecord
	r, err := dataeng.NewReader(context.Background(), &chunkReader{data: data, size: 333},
		func(rec dataeng.Record) error {
			payload := make([]byte, len(rec.Payload))
			copy(payload, rec.Payload)
			got = append(got, gotRecord{payload: payload, start: rec.LogicalStart})
			return nil
		}, opts)
	if err != nil {
		return nil, nil, err
	}
	err = r.Read()
	return got, r, err
}

func TestCheckpointResumeNoDuplicates(t *testing.T) {
	enc := buildMixedLog(t)

	// 选择一个确定的已确认边界：第 3 条记录（索引 2）闭合后的物理位置。
	boundary := enc.records[2].fragments[len(enc.records[2].fragments)-1].start
	boundary += int64(len(enc.records[2].fragments[len(enc.records[2].fragments)-1].payload)) + encHeaderSize
	firstN := 3

	var cp dataeng.Checkpoint
	{
		var got []gotRecord
		var r *dataeng.Reader
		r, err := dataeng.NewReader(context.Background(), &limitedEOF{data: enc.buf, limit: int(boundary)},
			func(rec dataeng.Record) error {
				payload := append([]byte(nil), rec.Payload...)
				got = append(got, gotRecord{payload: payload, start: rec.LogicalStart})
				return nil
			}, dataeng.Options{Mode: dataeng.Strict})
		if err != nil {
			t.Fatalf("first read err=%v", err)
		}
		if err := r.Read(); err != nil && !errors.Is(err, io.EOF) {
			t.Fatalf("first read finish=%v", err)
		}
		if len(got) != firstN {
			t.Fatalf("prefix delivered=%d want=%d", len(got), firstN)
		}
		var ok bool
		cp, ok = r.Checkpoint()
		if !ok {
			t.Fatalf("checkpoint unavailable after prefix")
		}
		if cp.PrefixBytes != boundary {
			t.Fatalf("checkpoint pos=%d want boundary=%d", cp.PrefixBytes, boundary)
		}
	}

	// 用检查点恢复：前缀被重新扫描，交付的记录不能与前 firstN 条重复。
	var resumed []gotRecord
	r, err := dataeng.NewReader(context.Background(), &chunkReader{data: enc.buf, size: 1234},
		func(rec dataeng.Record) error {
			resumed = append(resumed, gotRecord{payload: append([]byte(nil), rec.Payload...), start: rec.LogicalStart})
			return nil
		}, dataeng.Options{Mode: dataeng.Strict, Resume: &cp})
	if err != nil {
		t.Fatalf("resume construct err=%v", err)
	}
	if err := r.Read(); err != io.EOF {
		t.Fatalf("resume read err=%v", err)
	}

	if len(resumed) != len(enc.records)-firstN {
		t.Fatalf("resumed count=%d want=%d", len(resumed), len(enc.records)-firstN)
	}
	for i, rec := range resumed {
		want := enc.records[firstN+i]
		if rec.start != want.logicalStart {
			t.Fatalf("resumed rec %d start mismatch", i)
		}
	}

	// 恢复后检查点应推进到最后一条确认记录的边界；其后的块零填充不属于任何记录，
	// 因此检查点摘要对应该边界前缀，而非含填充的整个文件。
	endCP, ok := r.Checkpoint()
	if !ok {
		t.Fatalf("end checkpoint unavailable")
	}
	lastRec := enc.records[len(enc.records)-1]
	lastFrag := lastRec.fragments[len(lastRec.fragments)-1]
	wantEnd := lastFrag.start + encHeaderSize + int64(len(lastFrag.payload))
	if endCP.PrefixBytes != wantEnd {
		t.Fatalf("end prefix=%d want=%d", endCP.PrefixBytes, wantEnd)
	}
	if endCP.PrefixSHA256 != sha256.Sum256(enc.buf[:wantEnd]) {
		t.Fatalf("end prefix sha256 mismatch")
	}
}

func TestCheckpointRejectsNonBoundaryAndBadHash(t *testing.T) {
	enc := buildMixedLog(t)

	// 取一个真实检查点后，把位置挪到片中间：必须被拒绝（不是逻辑记录边界）。
	got, _, err := collect(t, enc.buf, dataeng.Options{Mode: dataeng.Strict})
	if err != io.EOF {
		t.Fatalf("collect err=%v", err)
	}
	if len(got) == 0 {
		t.Fatalf("no records")
	}

	mid := dataeng.Checkpoint{
		PrefixBytes:  enc.records[1].fragments[0].start + 3,
		PrefixSHA256: sha256.Sum256(enc.buf[:enc.records[1].fragments[0].start+3]),
	}
	_, err = dataeng.NewReader(context.Background(), &chunkReader{data: enc.buf, size: 99},
		nil, dataeng.Options{Resume: &mid})
	assertKind(t, err, dataeng.ErrCheckpoint, -1)

	// 取一个真实确认边界（第 3 条记录闭合处，其后紧跟数据、无块填充），
	// 仅篡改哈希：重新扫描得到的前缀摘要必须与之不符并拒绝。
	b3 := enc.records[2].fragments[len(enc.records[2].fragments)-1]
	boundary := int(b3.start + encHeaderSize + int64(len(b3.payload)))
	tampered := dataeng.Checkpoint{
		PrefixBytes:  int64(boundary),
		PrefixSHA256: sha256.Sum256(enc.buf[:boundary]),
	}
	tampered.PrefixSHA256[0] ^= 0xFF
	_, err = dataeng.NewReader(context.Background(), &chunkReader{data: enc.buf, size: 55},
		nil, dataeng.Options{Resume: &tampered})
	assertKind(t, err, dataeng.ErrCheckpoint, -1)
}

func TestCheckpointCannotStartAtMiddle(t *testing.T) {
	enc := &encoder{}
	enc.PutChunks(payloadBytes(40000, 1), 333)
	// 检查点位置取 FIRST 片之后的 MIDDLE 载荷中间：扫描会发现停在组装态。
	middle := enc.records[0].fragments[1].start + 10
	cp := dataeng.Checkpoint{
		PrefixBytes:  int64(middle),
		PrefixSHA256: sha256.Sum256(enc.buf[:middle]),
	}
	_, err := dataeng.NewReader(context.Background(), &chunkReader{data: enc.buf, size: 4096},
		nil, dataeng.Options{Resume: &cp})
	assertKind(t, err, dataeng.ErrCheckpoint, -1)
}

func TestCallbackFailureStopsAndInvalidatesCheckpoint(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(5, 1))
	enc.PutFull(payloadBytes(6, 2))

	boom := errors.New("boom")
	var delivered int
	r, err := dataeng.NewReader(context.Background(), &chunkReader{data: enc.buf, size: 13},
		func(rec dataeng.Record) error {
			delivered++
			if delivered == 2 {
				return boom
			}
			return nil
		}, dataeng.Options{})
	if err != nil {
		t.Fatalf("construct err=%v", err)
	}
	err = r.Read()
	var pe *dataeng.Error
	if !errors.As(err, &pe) || pe.Kind != dataeng.ErrCallback {
		t.Fatalf("err=%v want ErrCallback", err)
	}
	if !errors.Is(err, boom) {
		t.Fatalf("callback cause not wrapped")
	}

	// 终止后读取返回 ErrTerminated，且不会颁发包含失败记录的检查点。
	if err := r.Read(); err == nil {
		t.Fatalf("expected termination error")
	}
	cp, ok := r.Checkpoint()
	_ = cp
	if ok {
		t.Fatalf("checkpoint must not be issued after failed callback")
	}
}
