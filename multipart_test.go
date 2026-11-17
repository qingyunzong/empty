package formal

import (
	"bytes"
	"errors"
	"fmt"
	"sync"
	"testing"
)

func putOK(t *testing.T, g *Gateway, uploadID string, number int, offset int64, data []byte) uint64 {
	t.Helper()
	gen, err := g.PutPart(uploadID, PartSpec{Number: number, Offset: offset, Digest: DigestOf(data)}, data)
	if err != nil {
		t.Fatalf("PutPart(%d) failed: %v", number, err)
	}
	return gen
}

func TestPutPartValidation(t *testing.T) {
	g := NewGateway()
	id := g.BeginUpload("k")

	if _, err := g.PutPart(id, PartSpec{Number: 0, Offset: 0, Digest: DigestOf([]byte("x"))}, []byte("x")); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("part number 0: got %v, want ErrInvalidRange", err)
	}
	if _, err := g.PutPart(id, PartSpec{Number: 1, Offset: -1, Digest: DigestOf([]byte("x"))}, []byte("x")); !errors.Is(err, ErrInvalidRange) {
		t.Fatalf("negative offset: got %v, want ErrInvalidRange", err)
	}
	if _, err := g.PutPart(id, PartSpec{Number: 1, Offset: 0, Digest: DigestOf([]byte("other"))}, []byte("x")); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("bad digest: got %v, want ErrDigestMismatch", err)
	}
	if _, err := g.PutPart("nope", PartSpec{Number: 1, Offset: 0, Digest: DigestOf([]byte("x"))}, []byte("x")); !errors.Is(err, ErrUnknownUpload) {
		t.Fatalf("unknown upload: got %v, want ErrUnknownUpload", err)
	}
}

func TestIdempotentReupload(t *testing.T) {
	g := NewGateway()
	id := g.BeginUpload("k")
	data := []byte("hello")
	spec := PartSpec{Number: 1, Offset: 0, Digest: DigestOf(data)}

	gen1, err := g.PutPart(id, spec, data)
	if err != nil {
		t.Fatal(err)
	}
	gen2, err := g.PutPart(id, spec, data)
	if err != nil {
		t.Fatal(err)
	}
	if gen1 != gen2 {
		t.Fatalf("idempotent re-upload changed generation: %d then %d", gen1, gen2)
	}
}

func TestOverwriteInvalidatesComplete(t *testing.T) {
	g := NewGateway()
	id := g.BeginUpload("k")

	v1 := []byte("aaaa")
	v2 := []byte("bbbb")
	gen1 := putOK(t, g, id, 1, 0, v1)
	stale := []PartRef{{Number: 1, Gen: gen1, Offset: 0, Size: int64(len(v1)), Digest: DigestOf(v1)}}

	gen2 := putOK(t, g, id, 1, 0, v2)
	if gen2 <= gen1 {
		t.Fatalf("overwrite did not bump generation: %d -> %d", gen1, gen2)
	}

	if _, err := g.Complete(id, stale); !errors.Is(err, ErrStaleGeneration) {
		t.Fatalf("stale manifest: got %v, want ErrStaleGeneration", err)
	}

	fresh := []PartRef{{Number: 1, Gen: gen2, Offset: 0, Size: int64(len(v2)), Digest: DigestOf(v2)}}
	version, err := g.Complete(id, fresh)
	if err != nil {
		t.Fatalf("fresh manifest rejected: %v", err)
	}
	got, gotVersion, ok := g.GetObject("k")
	if !ok || gotVersion != version || !bytes.Equal(got, v2) {
		t.Fatalf("visible object = %q v%d, want %q v%d", got, gotVersion, v2, version)
	}
}

func TestCompleteValidatesManifest(t *testing.T) {
	g := NewGateway()
	id := g.BeginUpload("k")
	a := []byte("aa")
	b := []byte("bb")
	genA := putOK(t, g, id, 1, 0, a)
	genB := putOK(t, g, id, 2, 2, b)

	// Gap between ranges.
	gap := []PartRef{
		{Number: 1, Gen: genA, Offset: 0, Size: 2, Digest: DigestOf(a)},
		{Number: 2, Gen: genB, Offset: 5, Size: 2, Digest: DigestOf(b)},
	}
	if _, err := g.Complete(id, gap); !errors.Is(err, ErrManifestInvalid) {
		t.Fatalf("gapped manifest: got %v, want ErrManifestInvalid", err)
	}

	// Wrong digest.
	badDigest := []PartRef{
		{Number: 1, Gen: genA, Offset: 0, Size: 2, Digest: DigestOf(a)},
		{Number: 2, Gen: genB, Offset: 2, Size: 2, Digest: DigestOf([]byte("zz"))},
	}
	if _, err := g.Complete(id, badDigest); !errors.Is(err, ErrManifestMismatch) {
		t.Fatalf("wrong digest: got %v, want ErrManifestMismatch", err)
	}

	// Unknown part number.
	missing := []PartRef{
		{Number: 1, Gen: genA, Offset: 0, Size: 2, Digest: DigestOf(a)},
		{Number: 9, Gen: 1, Offset: 2, Size: 2, Digest: DigestOf(b)},
	}
	if _, err := g.Complete(id, missing); !errors.Is(err, ErrManifestMismatch) {
		t.Fatalf("unknown part: got %v, want ErrManifestMismatch", err)
	}

	// Valid manifest commits and concatenates in range order.
	good := []PartRef{
		{Number: 1, Gen: genA, Offset: 0, Size: 2, Digest: DigestOf(a)},
		{Number: 2, Gen: genB, Offset: 2, Size: 2, Digest: DigestOf(b)},
	}
	version, err := g.Complete(id, good)
	if err != nil {
		t.Fatal(err)
	}
	got, gotVersion, ok := g.GetObject("k")
	if !ok || gotVersion != version || !bytes.Equal(got, []byte("aabb")) {
		t.Fatalf("visible object = %q, want %q", got, "aabb")
	}

	// Idempotent replay of the same manifest.
	again, err := g.Complete(id, good)
	if err != nil || again != version {
		t.Fatalf("idempotent complete replay = v%d, %v; want v%d, nil", again, err, version)
	}

	// A different manifest after close is rejected.
	other := []PartRef{{Number: 1, Gen: genA, Offset: 0, Size: 2, Digest: DigestOf(a)}}
	if _, err := g.Complete(id, other); !errors.Is(err, ErrUploadClosed) {
		t.Fatalf("complete after close: got %v, want ErrUploadClosed", err)
	}
	if _, err := g.PutPart(id, PartSpec{Number: 3, Offset: 4, Digest: DigestOf(a)}, a); !errors.Is(err, ErrUploadClosed) {
		t.Fatalf("put after close: got %v, want ErrUploadClosed", err)
	}
}

// TestConcurrentCompleteSingleVisible races several upload sessions that
// complete the same key with distinct payloads while readers poll the
// object. Every observed version must be exactly one committed manifest's
// concatenation, and the final object must be the highest committed version.
func TestConcurrentCompleteSingleVisible(t *testing.T) {
	g := NewGateway()
	const workers = 8

	payloads := make([][]byte, workers)
	versions := make([]uint64, workers)
	var wg sync.WaitGroup

	stop := make(chan struct{})
	var readWG sync.WaitGroup
	errs := make(chan error, 64)
	for r := 0; r < 4; r++ {
		readWG.Add(1)
		go func() {
			defer readWG.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				data, _, ok := g.GetObject("k")
				if !ok {
					continue
				}
				match := false
				for w := 0; w < workers; w++ {
					if bytes.Equal(data, payloads[w]) {
						match = true
						break
					}
				}
				if !match {
					select {
					case errs <- fmt.Errorf("reader observed torn object %q", data):
					default:
					}
					return
				}
			}
		}()
	}

	for w := 0; w < workers; w++ {
		payloads[w] = []byte(fmt.Sprintf("payload-%02d-part1-part2", w))
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			id := g.BeginUpload("k")
			p1 := payloads[w][:11]
			p2 := payloads[w][11:]
			gen1 := putOK(t, g, id, 1, 0, p1)
			gen2 := putOK(t, g, id, 2, int64(len(p1)), p2)
			manifest := []PartRef{
				{Number: 1, Gen: gen1, Offset: 0, Size: int64(len(p1)), Digest: DigestOf(p1)},
				{Number: 2, Gen: gen2, Offset: int64(len(p1)), Size: int64(len(p2)), Digest: DigestOf(p2)},
			}
			version, err := g.Complete(id, manifest)
			if err != nil {
				select {
				case errs <- fmt.Errorf("worker %d complete failed: %w", w, err):
				default:
				}
				return
			}
			versions[w] = version
		}(w)
	}
	wg.Wait()
	close(stop)
	readWG.Wait()

	select {
	case err := <-errs:
		t.Fatal(err)
	default:
	}

	// The final visible object must be the highest committed version.
	best, bestVersion := -1, uint64(0)
	for w := 0; w < workers; w++ {
		if versions[w] > bestVersion {
			best, bestVersion = w, versions[w]
		}
	}
	got, gotVersion, ok := g.GetObject("k")
	if !ok || gotVersion != bestVersion || !bytes.Equal(got, payloads[best]) {
		t.Fatalf("final object = %q v%d, want %q v%d", got, gotVersion, payloads[best], bestVersion)
	}
}
