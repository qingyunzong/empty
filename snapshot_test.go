package noderecovery

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// buildSnapshot serializes data and splits it into chunks of chunkSize.
func buildSnapshot(id string, lastIndex uint64, data map[string]string, chunkSize int) []Chunk {
	payload, err := json.Marshal(struct {
		Data map[string]string `json:"data"`
	}{Data: data})
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(payload)
	var chunks []Chunk
	for off := 0; off < len(payload); off += chunkSize {
		end := off + chunkSize
		if end > len(payload) {
			end = len(payload)
		}
		chunks = append(chunks, Chunk{
			SnapshotID: id,
			LastIndex:  lastIndex,
			Offset:     int64(off),
			Data:       payload[off:end],
			Last:       end == len(payload),
			Digest:     digest,
		})
	}
	return chunks
}

func openNode(t *testing.T, dir string) *Node {
	t.Helper()
	n, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return n
}

func TestChunkedInstallPublishesAtomically(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	defer n.Close()

	for i := uint64(1); i <= 3; i++ {
		if err := n.Append(Entry{Index: i, Key: fmt.Sprintf("old%d", i), Value: "x"}); err != nil {
			t.Fatal(err)
		}
	}

	newState := map[string]string{"fresh1": "a", "fresh2": "b"}
	chunks := buildSnapshot("snap-1", 5, newState, 16)
	if len(chunks) < 3 {
		t.Fatalf("want several chunks, got %d", len(chunks))
	}

	// Deliver out of order: everything except the first chunk, then the first.
	for _, c := range chunks[1:] {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	// Not yet complete: old state must still be visible.
	if got := n.State(); !reflect.DeepEqual(got, map[string]string{"old1": "x", "old2": "x", "old3": "x"}) {
		t.Fatalf("state changed before publish: %v", got)
	}
	if got := n.AppliedIndex(); got != 3 {
		t.Fatalf("applied index changed before publish: %d", got)
	}

	if err := n.ReceiveChunk(chunks[0]); err != nil {
		t.Fatal(err)
	}
	if got := n.State(); !reflect.DeepEqual(got, newState) {
		t.Fatalf("state after publish = %v, want %v", got, newState)
	}
	if got := n.AppliedIndex(); got != 5 {
		t.Fatalf("applied index after publish = %d, want 5", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "incoming")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("incoming dir not cleaned after publish")
	}
}

func TestLogBufferingDuringInstall(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	defer n.Close()

	if err := n.Append(Entry{Index: 1, Key: "keep", Value: "old"}); err != nil {
		t.Fatal(err)
	}

	chunks := buildSnapshot("snap-1", 5, map[string]string{"keep": "snap", "from_snap": "1"}, 16)
	// Start the installation, then append entries while it is in progress.
	if err := n.ReceiveChunk(chunks[0]); err != nil {
		t.Fatal(err)
	}
	for _, e := range []Entry{
		{Index: 4, Key: "stale", Value: "drop"},  // covered by snapshot
		{Index: 6, Key: "live", Value: "apply"},  // beyond snapshot
		{Index: 5, Key: "stale2", Value: "drop"}, // covered by snapshot
	} {
		if err := n.Append(e); err != nil {
			t.Fatal(err)
		}
	}
	// Buffered entries must not be visible during the install.
	if _, ok := n.State()["live"]; ok {
		t.Fatal("buffered entry applied during install")
	}

	for _, c := range chunks[1:] {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}

	want := map[string]string{"keep": "snap", "from_snap": "1", "live": "apply"}
	if got := n.State(); !reflect.DeepEqual(got, want) {
		t.Fatalf("state = %v, want %v", got, want)
	}
	if got := n.AppliedIndex(); got != 6 {
		t.Fatalf("applied index = %d, want 6", got)
	}
}

func TestDuplicateChunk(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	defer n.Close()

	if err := n.Append(Entry{Index: 1, Key: "old", Value: "state"}); err != nil {
		t.Fatal(err)
	}
	oldState := n.State()

	chunks := buildSnapshot("snap-1", 4, map[string]string{"new": "state"}, 16)

	// Identical duplicate is idempotent.
	if err := n.ReceiveChunk(chunks[0]); err != nil {
		t.Fatal(err)
	}
	if err := n.ReceiveChunk(chunks[0]); err != nil {
		t.Fatalf("identical duplicate chunk rejected: %v", err)
	}

	// Same offset, different content fails the installation.
	bad := chunks[1]
	bad.Offset = chunks[0].Offset
	bad.Data = append([]byte(nil), chunks[0].Data...)
	bad.Data[0] ^= 0xff
	if err := n.ReceiveChunk(bad); !errors.Is(err, ErrDuplicateConflict) {
		t.Fatalf("conflicting duplicate: got %v, want ErrDuplicateConflict", err)
	}

	// Old state intact, installation aborted.
	if got := n.State(); !reflect.DeepEqual(got, oldState) {
		t.Fatalf("state = %v, want old state %v", got, oldState)
	}
	if _, err := os.Stat(filepath.Join(dir, "incoming")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("incoming dir not cleaned after abort")
	}

	// A fresh installation can start afterwards.
	for _, c := range chunks {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	if got := n.State(); !reflect.DeepEqual(got, map[string]string{"new": "state"}) {
		t.Fatalf("state after retry = %v", got)
	}
}

func TestRestartMidInstallKeepsOldState(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	if err := n.Append(Entry{Index: 1, Key: "old", Value: "state"}); err != nil {
		t.Fatal(err)
	}

	chunks := buildSnapshot("snap-1", 4, map[string]string{"new": "state"}, 16)
	// Deliver all but the last chunk, then "crash".
	for _, c := range chunks[:len(chunks)-1] {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}

	// After restart the old state is fully intact.
	n = openNode(t, dir)
	defer n.Close()
	if got := n.State(); !reflect.DeepEqual(got, map[string]string{"old": "state"}) {
		t.Fatalf("state after restart = %v, want old state", got)
	}
	if got := n.AppliedIndex(); got != 1 {
		t.Fatalf("applied index after restart = %d, want 1", got)
	}

	// The interrupted installation resumes: already-received chunks are
	// idempotent, the final chunk completes the publish.
	for _, c := range chunks {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	if got := n.State(); !reflect.DeepEqual(got, map[string]string{"new": "state"}) {
		t.Fatalf("state after resumed install = %v", got)
	}
}

func TestRestartAfterPublishKeepsNewState(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	if err := n.Append(Entry{Index: 1, Key: "old", Value: "state"}); err != nil {
		t.Fatal(err)
	}
	for _, c := range buildSnapshot("snap-1", 4, map[string]string{"new": "state"}, 16) {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	if err := n.Append(Entry{Index: 5, Key: "post", Value: "entry"}); err != nil {
		t.Fatal(err)
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}

	n = openNode(t, dir)
	defer n.Close()
	want := map[string]string{"new": "state", "post": "entry"}
	if got := n.State(); !reflect.DeepEqual(got, want) {
		t.Fatalf("state after restart = %v, want %v", got, want)
	}
	if got := n.AppliedIndex(); got != 5 {
		t.Fatalf("applied index after restart = %d, want 5", got)
	}
}

func TestCrossVersionChunksRejected(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	defer n.Close()

	if err := n.Append(Entry{Index: 1, Key: "old", Value: "state"}); err != nil {
		t.Fatal(err)
	}
	oldState := n.State()

	v1 := buildSnapshot("snap-1", 4, map[string]string{"v": "one"}, 16)
	v2 := buildSnapshot("snap-2", 7, map[string]string{"v": "two"}, 16)

	if err := n.ReceiveChunk(v1[0]); err != nil {
		t.Fatal(err)
	}
	// A chunk from a different snapshot version is rejected.
	if err := n.ReceiveChunk(v2[0]); !errors.Is(err, ErrVersionMismatch) {
		t.Fatalf("cross-version chunk: got %v, want ErrVersionMismatch", err)
	}
	// State untouched: still fully old.
	if got := n.State(); !reflect.DeepEqual(got, oldState) {
		t.Fatalf("state = %v, want old state %v", got, oldState)
	}

	// The original version completes and publishes fully.
	for _, c := range v1[1:] {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	if got := n.State(); !reflect.DeepEqual(got, map[string]string{"v": "one"}) {
		t.Fatalf("state = %v, want v1 state", got)
	}
	if got := n.AppliedIndex(); got != 4 {
		t.Fatalf("applied index = %d, want 4", got)
	}

	// Afterwards the other version can be installed cleanly.
	for _, c := range v2 {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	if got := n.State(); !reflect.DeepEqual(got, map[string]string{"v": "two"}) {
		t.Fatalf("state = %v, want v2 state", got)
	}
	if got := n.AppliedIndex(); got != 7 {
		t.Fatalf("applied index = %d, want 7", got)
	}
}

func TestDigestMismatchAbortsInstall(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	defer n.Close()

	if err := n.Append(Entry{Index: 1, Key: "old", Value: "state"}); err != nil {
		t.Fatal(err)
	}
	oldState := n.State()

	chunks := buildSnapshot("snap-1", 4, map[string]string{"new": "state"}, 16)
	// Corrupt one payload byte; the announced digest no longer matches.
	last := &chunks[len(chunks)-1]
	last.Data = append([]byte(nil), last.Data...)
	last.Data[len(last.Data)-1] ^= 0xff

	var err error
	for _, c := range chunks {
		err = n.ReceiveChunk(c)
	}
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("got %v, want ErrDigestMismatch", err)
	}
	if got := n.State(); !reflect.DeepEqual(got, oldState) {
		t.Fatalf("state = %v, want old state %v", got, oldState)
	}
	if got := n.AppliedIndex(); got != 1 {
		t.Fatalf("applied index = %d, want 1", got)
	}
}

func TestStaleEntriesIgnored(t *testing.T) {
	dir := t.TempDir()
	n := openNode(t, dir)
	defer n.Close()

	for _, c := range buildSnapshot("snap-1", 4, map[string]string{"k": "snap"}, 16) {
		if err := n.ReceiveChunk(c); err != nil {
			t.Fatal(err)
		}
	}
	// Entries at or below the snapshot index are ignored.
	if err := n.Append(Entry{Index: 3, Key: "k", Value: "stale"}); err != nil {
		t.Fatal(err)
	}
	if got := n.State()["k"]; got != "snap" {
		t.Fatalf("stale entry overwrote state: %q", got)
	}
	if got := n.AppliedIndex(); got != 4 {
		t.Fatalf("applied index = %d, want 4", got)
	}
}
