package dataeng

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func testArchive(t *testing.T, opts ...Option) (*Archive, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "archive")
	a, err := Open(root, opts...)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	return a, root
}

func ts(sec int) time.Time { return time.Unix(1_700_000_000+int64(sec), 0) }

func event(run, target, req string, typ EventType, seq int64, fields map[string]any) Event {
	return Event{
		Type: typ, Run: run, Target: target, RequestID: req,
		Seq: seq, Timestamp: ts(int(seq)), Fields: fields,
	}
}

func bodyEvent(run, target, req string, typ EventType, seq int64, body []byte) Event {
	ev := event(run, target, req, typ, seq, nil)
	ev.Body = body
	return ev
}

func TestIngestOutOfOrderMergesAndCloses(t *testing.T) {
	a, _ := testArchive(t)
	run, target, req := "run-1", "page-A", "req-1"

	// 响应先于请求到达：先形成未闭合记录，请求补全后正常闭合。
	if _, err := a.Ingest(event(run, target, req, EvResponse, 2, map[string]any{
		"status": 200, "statusText": "OK",
		"headers": []any{map[string]any{"name": "ct", "value": "text/plain"}},
	})); err != nil {
		t.Fatalf("ingest response: %v", err)
	}
	rec, err := a.GetRecord(run, target, req)
	if err != nil {
		t.Fatal(err)
	}
	if rec.State != StateComplete {
		t.Fatalf("response should close record, got %q", rec.State)
	}

	if _, err := a.Ingest(event(run, target, req, EvRequest, 1, map[string]any{
		"method": "GET", "url": "https://example.test/",
	})); err != nil {
		t.Fatalf("ingest request: %v", err)
	}
	rec, _ = a.GetRecord(run, target, req)
	if got := rec.Request().Method; got != "GET" {
		t.Fatalf("method = %q", got)
	}
	if got := rec.Response().Status; got != 200 {
		t.Fatalf("status = %d", got)
	}
	if got := rec.Response().Headers[0].Name; got != "ct" {
		t.Fatalf("header = %q", got)
	}
	if len(rec.AppliedEvents) != 2 {
		t.Fatalf("applied events = %d", len(rec.AppliedEvents))
	}
}

func TestOpenRecordPersistedUntilBodyArrives(t *testing.T) {
	a, root := testArchive(t)
	run, target, req := "run-2", "page-B", "req-9"

	if _, err := a.Ingest(event(run, target, req, EvRequest, 1, map[string]any{
		"method": "POST", "url": "https://example.test/upload",
	})); err != nil {
		t.Fatal(err)
	}
	openPath := openRecordPath(root, run, target, req)
	if _, err := os.Stat(openPath); err != nil {
		t.Fatalf("open snapshot should exist: %v", err)
	}

	// 晚到的响应正文不会闭合状态变化，但响应头到达后 open 快照应被清除。
	if _, err := a.Ingest(event(run, target, req, EvResponse, 3, map[string]any{
		"status": 201,
	})); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(openPath); !os.IsNotExist(err) {
		t.Fatalf("open snapshot should be removed after close, got err=%v", err)
	}

	// 正文在闭合之后晚到，run 未封闭时仍归并到同一记录。
	if _, err := a.Ingest(bodyEvent(run, target, req, EvResponseBody, 4, []byte("created"))); err != nil {
		t.Fatal(err)
	}
	rec, _ := a.GetRecord(run, target, req)
	if rec.RespBody == nil || rec.RespBody.Digest == "" {
		t.Fatal("late body should be attached")
	}
	data, err := a.BlobData(rec.RespBody.Algo, rec.RespBody.Digest)
	if err != nil || string(data) != "created" {
		t.Fatalf("blob read = %q, err=%v", data, err)
	}
}

func TestSealThenLateEventsCreateRevisions(t *testing.T) {
	a, root := testArchive(t)
	run, target, req := "run-3", "page-C", "req-1"

	_, _ = a.Ingest(event(run, target, req, EvRequest, 1, map[string]any{
		"method": "GET", "url": "https://example.test/x",
	}))
	_, _ = a.Ingest(event(run, target, req, EvResponse, 3, map[string]any{
		"status": 200,
	}))
	// 第二个请求封闭时仍未收到响应，成为 sealed-open 记录。
	_, _ = a.Ingest(event(run, target, "req-2", EvRequest, 2, map[string]any{
		"method": "GET", "url": "https://example.test/y",
	}))

	summary, err := a.CloseRun(run)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Complete != 1 || summary.SealedOpen != 1 || summary.RecordCount != 2 {
		t.Fatalf("summary = %+v", summary)
	}

	if _, err := os.Stat(baseRecordPath(root, run, target, req)); err != nil {
		t.Fatalf("base record missing: %v", err)
	}
	if _, err := os.Stat(openRecordPath(root, run, target, "req-2")); !os.IsNotExist(err) {
		t.Fatal("open dir must be empty after seal")
	}

	// 封闭后迟到：req-1 的正文进入修订世代；req-2 收到响应也进修订世代。
	if _, err := a.Ingest(bodyEvent(run, target, req, EvResponseBody, 9, []byte("late-body"))); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Ingest(event(run, target, "req-2", EvResponse, 10, map[string]any{
		"status": 500,
	})); err != nil {
		t.Fatal(err)
	}

	idx, err := a.Revisions(run)
	if err != nil {
		t.Fatal(err)
	}
	if len(idx.Generations) != 2 {
		t.Fatalf("generations = %d, want 2", len(idx.Generations))
	}
	rev1, err := a.ReadRevision(run, 1, target, req)
	if err != nil {
		t.Fatal(err)
	}
	if rev1.Rev != 1 || rev1.RespBody == nil {
		t.Fatalf("revision record wrong: %+v", rev1)
	}
	base, _ := a.ReadBase(run, target, req)
	if base.RespBody != nil {
		t.Fatal("base generation must stay immutable")
	}
	rev2, _ := a.ReadRevision(run, 2, target, "req-2")
	if rev2.State != StateComplete || rev2.Response().Status != 500 {
		t.Fatalf("sealed-open late response wrong: %+v", rev2)
	}

	// 重复 CloseRun 幂等，不新增世代。
	if _, err := a.CloseRun(run); err != nil {
		t.Fatal(err)
	}
	idx2, _ := a.Revisions(run)
	if len(idx2.Generations) != 2 {
		t.Fatalf("re-seal changed generations: %d", len(idx2.Generations))
	}
}

func TestBlobDedupKeepsIndependentRefs(t *testing.T) {
	a, _ := testArchive(t)
	body := []byte("identical-payload")

	_, _ = a.Ingest(bodyEvent("run-a", "t1", "r1", EvResponseBody, 1, body))
	_, _ = a.Ingest(bodyEvent("run-a", "t1", "r2", EvResponseBody, 2, body))

	rec1, _ := a.GetRecord("run-a", "t1", "r1")
	rec2, _ := a.GetRecord("run-a", "t1", "r2")
	if rec1.RespBody.Digest != rec2.RespBody.Digest {
		t.Fatal("same payload must share digest")
	}
	refs, err := a.BlobRefs(rec1.RespBody.Algo, rec1.RespBody.Digest)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 {
		t.Fatalf("independent source refs = %d, want 2", len(refs))
	}

	// 同一来源关系重复登记必须幂等。
	ev := bodyEvent("run-a", "t1", "r1", EvResponseBody, 1, body)
	if _, err := a.Ingest(ev); err != nil {
		t.Fatal(err)
	}
	refs, _ = a.BlobRefs(rec1.RespBody.Algo, rec1.RespBody.Digest)
	if len(refs) != 2 {
		t.Fatalf("duplicate source must not add ref, got %d", len(refs))
	}
}

func TestIdempotentReplaySameEvents(t *testing.T) {
	a, _ := testArchive(t)
	ev := event("run-z", "t", "r", EvRequest, 1, map[string]any{"method": "GET", "url": "u"})
	first, err := a.Ingest(ev)
	if err != nil {
		t.Fatal(err)
	}
	second, err := a.Ingest(ev) // 无显式 ID，两次按内容派生相同 ID
	if err != nil {
		t.Fatal(err)
	}
	if first.AppliedEvents[0] == "" || first.AppliedEvents[0] != second.AppliedEvents[0] {
		t.Fatalf("derived event id must be stable: %q vs %q", first.AppliedEvents, second.AppliedEvents)
	}
	rec, _ := a.GetRecord("run-z", "t", "r")
	if len(rec.AppliedEvents) != 1 {
		t.Fatalf("replayed event applied twice: %d", len(rec.AppliedEvents))
	}

	explicit := ev
	explicit.ID = "fixed-id"
	if _, err := a.Ingest(explicit); err != nil {
		t.Fatal(err)
	}
	dup := explicit
	dup.Fields = map[string]any{"method": "POST"} // 相同 ID 仍按重复处理
	if _, err := a.Ingest(dup); err != nil {
		t.Fatal(err)
	}
	rec, _ = a.GetRecord("run-z", "t", "r")
	if got := rec.Request().Method; got != "GET" {
		t.Fatalf("duplicate explicit id must be skipped, method = %q", got)
	}
}

func TestRedirectChainSorted(t *testing.T) {
	a, _ := testArchive(t)
	run, target, req := "run-r", "t", "r"
	_, _ = a.Ingest(event(run, target, req, EvRedirect, 5, map[string]any{
		"status": 302, "from": "https://a", "to": "https://b",
	}))
	_, _ = a.Ingest(event(run, target, req, EvRedirect, 2, map[string]any{
		"status": 301, "from": "https://start", "to": "https://a",
	}))
	rec, _ := a.GetRecord(run, target, req)
	if len(rec.Redirects) != 2 || rec.Redirects[0].Seq != 2 || rec.Redirects[1].Seq != 5 {
		t.Fatalf("redirects not sorted by seq: %+v", rec.Redirects)
	}
}

func TestConcurrentIngestAcrossTargets(t *testing.T) {
	a, _ := testArchive(t, WithNoSync())
	var wg sync.WaitGroup
	for target := 0; target < 8; target++ {
		wg.Add(1)
		go func(target int) {
			defer wg.Done()
			tg := string(rune('A' + target))
			for i := 0; i < 25; i++ {
				ev := event("run-c", tg, "req", EvRequest, int64(i), map[string]any{
					"method": "GET", "url": "u",
				})
				ev.RequestID = "req-" + string(rune('a'+i))
				if _, err := a.Ingest(ev); err != nil {
					t.Errorf("ingest: %v", err)
					return
				}
			}
		}(target)
	}
	wg.Wait()
	recs, err := a.ListRecords("run-c")
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 8*25 {
		t.Fatalf("records = %d, want %d", len(recs), 8*25)
	}
}

func TestInvalidEventRejected(t *testing.T) {
	a, _ := testArchive(t)
	cases := []Event{
		{Type: EvRequest, Target: "t", RequestID: "r"}, // 缺 run
		{Type: EventType("nope"), Run: "r", Target: "t", RequestID: "q"},
		{Type: EvResponseBody, Run: "r", Target: "t", RequestID: "q"}, // 无正文也无摘要
	}
	for i, ev := range cases {
		if _, err := a.Ingest(ev); err == nil {
			t.Fatalf("case %d should fail", i)
		}
	}
}
