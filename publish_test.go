package artifactpub

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func sampleFiles() map[string][]byte {
	return NewBundle(
		[]byte("=== RUN TestA\n--- PASS: TestA\nPASS\n"),
		[]byte(`{"passed":1,"failed":0}`),
		0,
	)
}

func reopen(t *testing.T, root string) *Publisher {
	t.Helper()
	p, err := Open(root)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return p
}

func TestPublishAndLoad(t *testing.T) {
	root := t.TempDir()
	p := reopen(t, root)
	want := sampleFiles()

	digest, err := p.Publish("run-1", want)
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if digest != DigestOf("run-1", want) {
		t.Fatalf("digest mismatch")
	}

	m, got, err := p.Load("run-1")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if m.Digest != digest || m.RunID != "run-1" {
		t.Fatalf("unexpected manifest: %+v", m)
	}
	for name, data := range want {
		if string(got[name]) != string(data) {
			t.Fatalf("file %s content mismatch", name)
		}
	}
	code, err := ReadExitCode(got)
	if err != nil || code != 0 {
		t.Fatalf("ReadExitCode = %d, %v", code, err)
	}
	if !p.Published("run-1") {
		t.Fatal("Published = false after commit")
	}

	// Bundle files must be read-only once committed.
	info, err := os.Stat(filepath.Join(root, "bundles", "run-1", LogFileName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o444 {
		t.Fatalf("log file mode = %o, want 0444", info.Mode().Perm())
	}
}

func TestLoadNotPublished(t *testing.T) {
	p := reopen(t, t.TempDir())
	if _, _, err := p.Load("nope"); !errors.Is(err, ErrNotPublished) {
		t.Fatalf("Load err = %v, want ErrNotPublished", err)
	}
	if p.Published("nope") {
		t.Fatal("Published = true for unknown run")
	}
}

func TestRetrySameDigestIdempotent(t *testing.T) {
	root := t.TempDir()
	p := reopen(t, root)
	d1, err := p.Publish("run-1", sampleFiles())
	if err != nil {
		t.Fatal(err)
	}
	// Retry after a simulated restart with identical content.
	p = reopen(t, root)
	d2, err := p.Publish("run-1", sampleFiles())
	if err != nil {
		t.Fatalf("idempotent retry: %v", err)
	}
	if d1 != d2 {
		t.Fatalf("digest changed across retry: %s != %s", d1, d2)
	}
}

func TestRetryDifferentDigestRejected(t *testing.T) {
	root := t.TempDir()
	p := reopen(t, root)
	if _, err := p.Publish("run-1", sampleFiles()); err != nil {
		t.Fatal(err)
	}
	changed := sampleFiles()
	changed[SummaryFileName] = []byte(`{"passed":0,"failed":1}`)
	if _, err := p.Publish("run-1", changed); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("Publish err = %v, want ErrDigestMismatch", err)
	}
	// Original bundle must remain intact and readable.
	_, got, err := p.Load("run-1")
	if err != nil {
		t.Fatal(err)
	}
	if string(got[SummaryFileName]) != `{"passed":1,"failed":0}` {
		t.Fatal("original bundle was modified by rejected retry")
	}
}

// TestCrashAtEveryStep fails the publish at each fault-injection step,
// restarts, and asserts the reader sees either nothing or a complete
// bundle; a retry then succeeds.
func TestCrashAtEveryStep(t *testing.T) {
	steps := []struct {
		name         string
		visibleAfter bool // bundle visible after crash+restart
	}{
		{"stage.mkdir", false},
		{"stage.write", false},
		{"stage.manifest", false},
		{"stage.verify", false},
		{"commit.rename", false},
		{"commit.sync", true}, // rename already committed
	}
	for _, tc := range steps {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			p := reopen(t, root)
			crash := errors.New("injected crash at " + tc.name)
			p.hook = func(step string) error {
				if step == tc.name {
					return crash
				}
				return nil
			}
			if _, err := p.Publish("run-1", sampleFiles()); !errors.Is(err, crash) {
				t.Fatalf("Publish err = %v, want injected crash", err)
			}

			// Restart: recovery must clean up staging.
			p = reopen(t, root)
			entries, err := os.ReadDir(filepath.Join(root, "staging"))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("staging not cleaned after restart: %v", entries)
			}

			_, _, err = p.Load("run-1")
			if tc.visibleAfter {
				if err != nil {
					t.Fatalf("after crash at %s: Load = %v, want complete bundle", tc.name, err)
				}
			} else if !errors.Is(err, ErrNotPublished) {
				t.Fatalf("after crash at %s: Load = %v, want ErrNotPublished", tc.name, err)
			}

			// Retry after restart must succeed and be fully readable.
			if _, err := p.Publish("run-1", sampleFiles()); err != nil {
				t.Fatalf("retry after crash: %v", err)
			}
			m, got, err := p.Load("run-1")
			if err != nil {
				t.Fatalf("Load after retry: %v", err)
			}
			if m.Digest != DigestOf("run-1", sampleFiles()) {
				t.Fatal("digest mismatch after retry")
			}
			for name, data := range sampleFiles() {
				if string(got[name]) != string(data) {
					t.Fatalf("file %s mismatch after retry", name)
				}
			}
		})
	}
}

func TestLoadRejectsTamperedBundle(t *testing.T) {
	root := t.TempDir()
	p := reopen(t, root)
	if _, err := p.Publish("run-1", sampleFiles()); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "bundles", "run-1", LogFileName)
	if err := os.Chmod(logPath, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte("forged log"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.Load("run-1"); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Load err = %v, want ErrCorrupt", err)
	}
	if p.Published("run-1") {
		t.Fatal("Published = true for tampered bundle")
	}
}

func TestLoadRejectsExtraFile(t *testing.T) {
	root := t.TempDir()
	p := reopen(t, root)
	if _, err := p.Publish("run-1", sampleFiles()); err != nil {
		t.Fatal(err)
	}
	extra := filepath.Join(root, "bundles", "run-1", "sneaky.txt")
	if err := os.WriteFile(extra, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := p.Load("run-1"); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Load err = %v, want ErrCorrupt", err)
	}
}

func TestRetryRejectedWhenExistingCorrupt(t *testing.T) {
	root := t.TempDir()
	p := reopen(t, root)
	if _, err := p.Publish("run-1", sampleFiles()); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(root, "bundles", "run-1", LogFileName)
	os.Chmod(logPath, 0o644)
	os.WriteFile(logPath, []byte("corrupted"), 0o644)
	// Even an identical retry must not be acknowledged against a
	// corrupted bundle.
	if _, err := p.Publish("run-1", sampleFiles()); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Publish err = %v, want ErrCorrupt", err)
	}
}

func TestInvalidInput(t *testing.T) {
	p := reopen(t, t.TempDir())
	for _, id := range []string{"", ".", "..", "a/b", `a\b`, "a\x00b"} {
		if _, err := p.Publish(id, sampleFiles()); err == nil {
			t.Fatalf("Publish(%q) succeeded, want error", id)
		}
	}
	if _, err := p.Publish("run-1", nil); err == nil {
		t.Fatal("Publish with no files succeeded, want error")
	}
	bad := map[string][]byte{"../escape": []byte("x")}
	if _, err := p.Publish("run-1", bad); err == nil {
		t.Fatal("Publish with escaping file name succeeded, want error")
	}
	if _, err := p.Publish("run-1", map[string][]byte{manifestFileName: []byte("x")}); err == nil {
		t.Fatal("Publish with reserved manifest name succeeded, want error")
	}
}

func TestDigestIsContentAddressed(t *testing.T) {
	a := DigestOf("run-1", sampleFiles())
	b := DigestOf("run-1", sampleFiles())
	c := DigestOf("run-2", sampleFiles())
	changed := sampleFiles()
	changed[ExitCodeFileName] = []byte("1\n")
	d := DigestOf("run-1", changed)
	if a != b {
		t.Fatal("digest not deterministic")
	}
	if a == c {
		t.Fatal("digest ignores run ID")
	}
	if a == d {
		t.Fatal("digest ignores file content")
	}
	if len(a) != 64 {
		t.Fatalf("digest %q is not a hex sha256", a)
	}
}
