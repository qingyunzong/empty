package quotadl

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeSource delivers payload while declaring declaredLen bytes, so
// tests can inject file length changes.
type fakeSource struct {
	declared int64
	payload  []byte
	// block, if non-nil, makes Open wait for the context before
	// returning a reader that drips payload until ctx is cancelled.
	block bool
}

func (s fakeSource) Open(ctx context.Context) (io.ReadCloser, int64, error) {
	if s.block {
		return &blockingReader{ctx: ctx}, s.declared, nil
	}
	return io.NopCloser(bytes.NewReader(s.payload)), s.declared, nil
}

// blockingReader yields bytes slowly until its context is cancelled.
type blockingReader struct{ ctx context.Context }

func (r *blockingReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	case <-time.After(time.Millisecond):
	}
	p[0] = 'x'
	return 1, nil
}
func (r *blockingReader) Close() error { return nil }

func newDownloader(t *testing.T, total int64) (*Downloader, *Quota) {
	t.Helper()
	q := NewQuota(total)
	d, err := NewDownloader(q, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return d, q
}

func payload(n int64) []byte { return bytes.Repeat([]byte{'d'}, int(n)) }

func TestShortWriteRefundsSurplus(t *testing.T) {
	d, q := newDownloader(t, 1000)
	// Declares 100 bytes, delivers only 40.
	n, err := d.Download(context.Background(), "f", fakeSource{declared: 100, payload: payload(40)})
	if err != nil {
		t.Fatal(err)
	}
	if n != 40 {
		t.Fatalf("written = %d, want 40", n)
	}
	s := q.Stats()
	if s.Used != 40 || s.Reserved != 0 {
		t.Fatalf("stats = %+v, want used=40 reserved=0", s)
	}
}

func TestCancelReleasesReservation(t *testing.T) {
	d, q := newDownloader(t, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(5 * time.Millisecond)
		cancel()
	}()
	_, err := d.Download(ctx, "f", fakeSource{declared: 500, block: true})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	s := q.Stats()
	if s.Used != 0 || s.Reserved != 0 {
		t.Fatalf("stats = %+v, want all quota returned", s)
	}
	// Staging file must be gone.
	matches, _ := filepath.Glob(filepath.Join(d.dir, ".staging-*"))
	if len(matches) != 0 {
		t.Fatalf("leftover staging files: %v", matches)
	}
}

func TestCommitFailureReleasesReservation(t *testing.T) {
	d, q := newDownloader(t, 1000)
	boom := errors.New("injected rename failure")
	d.Rename = func(oldpath, newpath string) error { return boom }
	_, err := d.Download(context.Background(), "f", fakeSource{declared: 300, payload: payload(300)})
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want injected failure", err)
	}
	s := q.Stats()
	if s.Used != 0 || s.Reserved != 0 {
		t.Fatalf("stats = %+v, want all quota returned", s)
	}
}

func TestCommitConvertsToUsedAndCannotCancel(t *testing.T) {
	q := NewQuota(1000)
	lease, err := q.Reserve(200)
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Commit(150); err != nil {
		t.Fatal(err)
	}
	if err := lease.Release(); err == nil {
		t.Fatal("Release after Commit must fail")
	}
	s := q.Stats()
	if s.Used != 150 || s.Reserved != 0 {
		t.Fatalf("stats = %+v, want used=150 reserved=0", s)
	}
	// Double commit must fail too.
	if err := lease.Commit(1); err == nil {
		t.Fatal("second Commit must fail")
	}
}

func TestDeleteFreesUsedQuota(t *testing.T) {
	d, q := newDownloader(t, 1000)
	if _, err := d.Download(context.Background(), "f", fakeSource{declared: 200, payload: payload(200)}); err != nil {
		t.Fatal(err)
	}
	if err := d.Delete("f"); err != nil {
		t.Fatal(err)
	}
	s := q.Stats()
	if s.Used != 0 || s.Reserved != 0 {
		t.Fatalf("stats = %+v, want used=0 reserved=0", s)
	}
}

func TestLengthChangeInjection(t *testing.T) {
	d, q := newDownloader(t, 1000)
	// Undeclared growth: declares 10, delivers 60. The extra 50 must
	// be reserved on the fly and end up as used.
	if n, err := d.Download(context.Background(), "grow", fakeSource{declared: 10, payload: payload(60)}); err != nil || n != 60 {
		t.Fatalf("grow: n=%d err=%v", n, err)
	}
	// Shrink: declares 200, delivers 30. 170 refunded at commit.
	if n, err := d.Download(context.Background(), "shrink", fakeSource{declared: 200, payload: payload(30)}); err != nil || n != 30 {
		t.Fatalf("shrink: n=%d err=%v", n, err)
	}
	s := q.Stats()
	if s.Used != 90 || s.Reserved != 0 {
		t.Fatalf("stats = %+v, want used=90 reserved=0", s)
	}
	// Growth beyond quota must fail cleanly and return everything.
	d2, q2 := newDownloader(t, 100)
	_, err := d2.Download(context.Background(), "toobig", fakeSource{declared: 10, payload: payload(500)})
	if !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("err = %v, want ErrQuotaExceeded", err)
	}
	if s := q2.Stats(); s.Used != 0 || s.Reserved != 0 {
		t.Fatalf("stats = %+v, want all quota returned", s)
	}
}

func TestQuotaExceeded(t *testing.T) {
	q := NewQuota(100)
	if _, err := q.Reserve(60); err != nil {
		t.Fatal(err)
	}
	if _, err := q.Reserve(41); !errors.Is(err, ErrQuotaExceeded) {
		t.Fatalf("err = %v, want ErrQuotaExceeded", err)
	}
	if _, err := q.Reserve(40); err != nil {
		t.Fatal(err)
	}
}

// TestInterleavedDownloadsAndDeletes hammers the quota with concurrent
// downloads (with injected length changes), cancellations, injected
// commit failures and deletes, continuously checking the invariant
// used+reserved <= total, and verifies exact accounting at the end.
func TestInterleavedDownloadsAndDeletes(t *testing.T) {
	const total = 4096
	d, q := newDownloader(t, total)

	var mu sync.Mutex
	committed := map[string]int64{} // name -> bytes on disk
	var usedSum int64

	ctx, cancel := context.WithCancel(context.Background())
	var wg sync.WaitGroup

	// Invariant monitor.
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			s := q.Stats()
			if s.Used+s.Reserved > s.Total {
				t.Errorf("invariant violated: %+v", s)
				return
			}
			if s.Used < 0 || s.Reserved < 0 {
				t.Errorf("negative counters: %+v", s)
				return
			}
		}
	}()

	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(id) + 1))
			for i := 0; i < 60; i++ {
				r := rng.Intn(100)
				switch {
				case r < 55: // download, possibly with length change
					declared := int64(rng.Intn(600))
					actual := declared
					switch rng.Intn(3) {
					case 0:
						actual = declared / 2 // short write
					case 1:
						actual = declared + int64(rng.Intn(200)) // growth
					}
					name := fmt.Sprintf("w%d-f%d", id, i)
					dl := d
					if rng.Intn(10) == 0 {
						// Inject a commit failure.
						shallow := *d
						shallow.Rename = func(string, string) error { return errors.New("boom") }
						dl = &shallow
					}
					n, err := dl.Download(ctx, name, fakeSource{declared: declared, payload: payload(actual)})
					if err == nil {
						mu.Lock()
						committed[name] = n
						usedSum += n
						mu.Unlock()
					} else if !errors.Is(err, ErrQuotaExceeded) && !errors.Is(err, context.Canceled) && err.Error() != "quotadl: commit: boom" {
						t.Errorf("unexpected error: %v", err)
					}
				case r < 85: // delete a random committed file
					mu.Lock()
					var victim string
					var victimSize int64
					for name := range committed {
						victim = name
						victimSize = committed[name]
						break
					}
					if victim != "" {
						delete(committed, victim)
						usedSum -= victimSize
					}
					mu.Unlock()
					if victim != "" {
						if err := d.Delete(victim); err != nil {
							t.Errorf("delete %s: %v", victim, err)
						}
					}
				default: // cancel an in-flight download
					dctx, dcancel := context.WithCancel(ctx)
					delay := time.Duration(rng.Intn(3)) * time.Millisecond
					go func() {
						time.Sleep(delay)
						dcancel()
					}()
					d.Download(dctx, fmt.Sprintf("w%d-cancel%d", id, i), fakeSource{declared: 300, block: true})
				}
			}
		}(worker)
	}

	// Workers run bounded loops; cancel partway through to also
	// exercise context cancellation of in-flight downloads.
	time.Sleep(200 * time.Millisecond)
	cancel()
	close(stop)
	wg.Wait()

	// Final exactness: used must equal the sum of committed bytes.
	s := q.Stats()
	mu.Lock()
	want := usedSum
	mu.Unlock()
	if s.Reserved != 0 {
		t.Fatalf("reserved = %d after all downloads finished", s.Reserved)
	}
	if s.Used != want {
		t.Fatalf("used = %d, want %d (sum of committed files)", s.Used, want)
	}
	// On-disk reality must match the quota ledger.
	var diskSum int64
	entries, err := os.ReadDir(d.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			t.Fatal(err)
		}
		diskSum += info.Size()
	}
	if diskSum != s.Used {
		t.Fatalf("disk usage = %d, quota used = %d", diskSum, s.Used)
	}
	// Deleting everything returns used to zero.
	mu.Lock()
	for name := range committed {
		if err := d.Delete(name); err != nil {
			t.Errorf("cleanup delete %s: %v", name, err)
		}
	}
	mu.Unlock()
	if s := q.Stats(); s.Used != 0 || s.Reserved != 0 {
		t.Fatalf("final stats = %+v, want all quota returned", s)
	}
}
