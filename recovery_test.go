package dataeng

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func seedArchive(t *testing.T, root string) {
	t.Helper()
	a, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	run, target := "run-rec", "page"
	_, _ = a.Ingest(event(run, target, "req-1", EvRequest, 1, map[string]any{
		"method": "GET", "url": "https://example.test/1",
	}))
	_, _ = a.Ingest(event(run, target, "req-1", EvResponse, 2, map[string]any{"status": 200}))
	_, _ = a.Ingest(bodyEvent(run, target, "req-1", EvResponseBody, 3, []byte("payload-1")))
	_, _ = a.Ingest(event(run, target, "req-open", EvRequest, 4, map[string]any{
		"method": "GET", "url": "https://example.test/open",
	}))
	if _, err := a.CloseRun(run); err != nil {
		t.Fatal(err)
	}
	// 封闭后的迟到事件产生修订世代。
	_, _ = a.Ingest(bodyEvent(run, target, "req-open", EvResponseBody, 5, []byte("late")))
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestReplayRebuildsStateAndRevisions(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	seedArchive(t, root)

	a, err := Open(root)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer a.Close()

	sealed, err := a.IsSealed("run-rec")
	if err != nil || !sealed {
		t.Fatalf("sealed state lost: %v", err)
	}
	recs, err := a.ListRecords("run-rec")
	if err != nil || len(recs) != 2 {
		t.Fatalf("records after replay = %d, err=%v", len(recs), err)
	}
	rec, err := a.GetRecord("run-rec", "page", "req-1")
	if err != nil {
		t.Fatal(err)
	}
	if rec.Response().Status != 200 || rec.RespBody == nil {
		t.Fatalf("record not rebuilt: %+v", rec)
	}
	data, _ := a.BlobData(rec.RespBody.Algo, rec.RespBody.Digest)
	if string(data) != "payload-1" {
		t.Fatalf("blob payload = %q", data)
	}
	idx, err := a.Revisions("run-rec")
	if err != nil || len(idx.Generations) != 1 {
		t.Fatalf("revisions rebuilt = %d, err=%v", len(idx.Generations), err)
	}

	// 重放后再次投递完全相同的事件，必须被幂等过滤，不新增世代。
	_, err = a.Ingest(bodyEvent("run-rec", "page", "req-open", EvResponseBody, 5, []byte("late")))
	if err != nil {
		t.Fatal(err)
	}
	idx2, _ := a.Revisions("run-rec")
	if len(idx2.Generations) != 1 {
		t.Fatalf("replayed late event created revision: %d", len(idx2.Generations))
	}
}

func TestReplayRepersistsOpenSnapshots(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	a, _ := Open(root)
	run := "run-open-rec"
	_, _ = a.Ingest(event(run, "t", "r", EvRequest, 1, map[string]any{"method": "GET", "url": "u"}))
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err := os.Stat(openRecordPath(root, run, "t", "r")); err != nil {
		t.Fatalf("open snapshot should be rebuilt on replay: %v", err)
	}
	rec, _ := reopened.GetRecord(run, "t", "r")
	if rec == nil || rec.State != StateOpen {
		t.Fatalf("open record state wrong: %+v", rec)
	}
}

func TestPendingPublishAndIdempotentLedger(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	seedArchive(t, root)
	a, _ := Open(root)
	defer a.Close()

	items, err := a.PendingPublish("run-rec")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 { // 2 条基础世代 + 1 条修订世代
		t.Fatalf("pending items = %d, want 3", len(items))
	}

	keys := make([]string, len(items))
	for i, item := range items {
		keys[i] = item.Key
	}
	if err := a.MarkPublished(keys); err != nil {
		t.Fatal(err)
	}
	again, err := a.PendingPublish("run-rec")
	if err != nil || len(again) != 0 {
		t.Fatalf("after mark published pending = %d, err=%v", len(again), err)
	}

	// 模拟进程崩溃后重放：账本在磁盘上，恢复后仍然没有待发布项。
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	again, err = reopened.PendingPublish("run-rec")
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("recovery republished items: %d", len(again))
	}

	// 新的迟到事件形成新世代，只发布增量。
	_, _ = reopened.Ingest(bodyEvent("run-rec", "page", "req-1", EvResponseBody, 6, []byte("newer")))
	delta, err := reopened.PendingPublish("run-rec")
	if err != nil || len(delta) != 1 || delta[0].Kind != "revision" || delta[0].Rev != 2 {
		t.Fatalf("incremental pending = %+v, err=%v", delta, err)
	}
}

func TestPublishStreamRespectsContext(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	seedArchive(t, root)
	a, _ := Open(root)
	defer a.Close()

	ctx, cancel := context.WithCancel(context.Background())
	out := make(chan PendingItem)
	errCh := make(chan error, 1)
	go func() { errCh <- a.PublishStream(ctx, "run-rec", out) }()

	first := <-out
	if first.Kind != "record" {
		t.Fatalf("first item kind = %q", first.Kind)
	}
	cancel()
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("stream err = %v", err)
	}
}

func TestRevisionNumberingStableAcrossRestarts(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	seedArchive(t, root)

	// 第一次重启：已有 1 个修订世代。
	a, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	idx, _ := a.Revisions("run-rec")
	if len(idx.Generations) != 1 || idx.Generations[0].Gen != 1 {
		t.Fatalf("gen after first reopen = %+v", idx.Generations)
	}
	// 重启后新到的迟到事件必须接续世代号 2，而不是重新计数。
	if _, err := a.Ingest(bodyEvent("run-rec", "page", "req-1", EvResponseBody, 7, []byte("v2"))); err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}

	// 第二次重启：世代序列保持 1、2，且无重复累积。
	b, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	idx, _ = b.Revisions("run-rec")
	if len(idx.Generations) != 2 || idx.Generations[0].Gen != 1 || idx.Generations[1].Gen != 2 {
		t.Fatalf("gens after second reopen = %+v", idx.Generations)
	}
	rec, err := b.ReadRevision("run-rec", 2, "page", "req-1")
	if err != nil || rec.Rev != 2 || rec.RespBody == nil {
		t.Fatalf("gen-2 record wrong: %+v err=%v", rec, err)
	}

	// 再次重放整个历史，世代号仍然稳定。
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	c, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	idx, _ = c.Revisions("run-rec")
	if len(idx.Generations) != 2 {
		t.Fatalf("replay duplicated generations: %+v", idx.Generations)
	}
}

func TestExportHARStructure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "archive")
	seedArchive(t, root)
	a, _ := Open(root)
	defer a.Close()

	data, err := a.ExportHAR("run-rec", ExportOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Log struct {
			Version string `json:"version"`
			Entries []struct {
				Request struct {
					Method string `json:"method"`
				} `json:"request"`
				Response struct {
					Status int `json:"status"`
					Blob   *struct {
						Digest string `json:"digest"`
					} `json:"_blob"`
				} `json:"response"`
			} `json:"entries"`
		} `json:"log"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	if doc.Log.Version != "1.2" || len(doc.Log.Entries) != 2 {
		t.Fatalf("har doc wrong: %+v", doc.Log)
	}

	// 内联模式下正文应进入 content.text。
	inline, err := a.ExportHAR("run-rec", ExportOptions{InlineBodies: true})
	if err != nil {
		t.Fatal(err)
	}
	var inlineDoc map[string]any
	if err := json.Unmarshal(inline, &inlineDoc); err != nil {
		t.Fatal(err)
	}
	entries := inlineDoc["log"].(map[string]any)["entries"].([]any)
	foundText := false
	for _, e := range entries {
		content := e.(map[string]any)["response"].(map[string]any)["content"].(map[string]any)
		if text, ok := content["text"].(string); ok && text == "payload-1" {
			foundText = true
		}
	}
	if !foundText {
		t.Fatal("inline body text missing in HAR export")
	}
}
