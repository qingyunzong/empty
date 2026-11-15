package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
)

// Verification is the result of checking every shard in a manifest.
//
// Verified contains usable sequence numbers. Missing contains sequences that
// are absent from the manifest or could not be downloaded. Errors records
// verification failures (including missing shards). Watermark is the first
// sequence that is not covered by a contiguous verified prefix; a gap blocks
// it even when later shards verified successfully.
type Verification struct {
	SchemaVersion string
	Verified      []int64
	Missing       []int64
	Errors        map[int64]error
	Watermark     int64
}

// OK reports whether every shard in the manifest is verified.
func (v Verification) OK() bool {
	return len(v.Missing) == 0 && len(v.Errors) == 0
}

// VerifyAll downloads and verifies all shards concurrently, storing verified
// payloads in the configured Cache. It is useful as a repair/prefetch pass:
// missing shards do not prevent later shards from being verified and cached,
// and a subsequent VerifyAll or Open can reuse those cached shards.
//
// Invalid manifest metadata is returned as an error. Per-shard failures are
// reported in Verification instead.
func (c *Consumer) VerifyAll(ctx context.Context, manifest Manifest) (Verification, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	normalized, err := manifest.Normalize()
	if err != nil {
		return Verification{}, err
	}
	cfg := c.withDefaults()
	if cfg.Downloader == nil {
		return Verification{}, errors.New("dataeng: Downloader is required")
	}

	report := Verification{
		SchemaVersion: normalized.SchemaVersion,
		Errors:        make(map[int64]error),
	}
	if len(normalized.Shards) == 0 {
		report.Watermark = normalized.Start()
		return report, ctx.Err()
	}

	results := make([]error, len(normalized.Shards))
	jobs := make(chan int)
	var wg sync.WaitGroup
	workers := cfg.Concurrency
	if workers > len(normalized.Shards) {
		workers = len(normalized.Shards)
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobs {
				prepared, prepErr := cfg.prepareShard(ctx, normalized.Shards[idx])
				if prepared != nil {
					prepared.close()
				}
				results[idx] = prepErr
			}
		}()
	}

	sent := 0
loop:
	for sent < len(normalized.Shards) {
		select {
		case jobs <- sent:
			sent++
		case <-ctx.Done():
			break loop
		}
	}
	close(jobs)
	wg.Wait()

	for i := sent; i < len(results); i++ {
		results[i] = ctx.Err()
	}

	verified := make(map[int64]struct{}, len(results))
	for i, shard := range normalized.Shards {
		seq := shard.Sequence
		err := results[i]
		if err == nil {
			verified[seq] = struct{}{}
			report.Verified = append(report.Verified, seq)
			continue
		}
		report.Errors[seq] = err
		if errors.Is(err, ErrMissingShard) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			report.Missing = append(report.Missing, seq)
		}
	}

	for _, seq := range normalized.MissingSequences() {
		report.Missing = append(report.Missing, seq)
		if _, ok := report.Errors[seq]; !ok {
			report.Errors[seq] = &MissingShardError{Sequence: seq}
		}
	}

	report.Verified = append([]int64(nil), report.Verified...)
	sort.Slice(report.Verified, func(i, j int) bool { return report.Verified[i] < report.Verified[j] })
	sort.Slice(report.Missing, func(i, j int) bool { return report.Missing[i] < report.Missing[j] })

	report.Watermark = normalized.Start()
	for {
		if _, ok := verified[report.Watermark]; !ok {
			break
		}
		report.Watermark++
	}

	if err := ctx.Err(); err != nil {
		return report, err
	}
	return report, nil
}

// String provides a compact human-readable summary.
func (v Verification) String() string {
	return fmt.Sprintf("schema=%s verified=%d missing=%d failed=%d watermark=%d",
		v.SchemaVersion, len(v.Verified), len(v.Missing), len(v.Errors), v.Watermark)
}
