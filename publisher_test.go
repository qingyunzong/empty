package materialpub

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func sampleInput(runID string) Input {
	return Input{
		RunID:    runID,
		TestLog:  []byte("=== RUN TestA\n--- PASS: TestA\nPASS\nok\texample\t0.01s\n"),
		Summary:  []byte(`{"passed":1,"failed":0}`),
		ExitCode: 0,
	}
}

// crashAt returns an AfterOp hook that fails (simulating a crash) at op.
func crashAt(op string) func(string) error {
	return func(got string) error {
		if got == op {
			return fmt.Errorf("simulated crash at %s", op)
		}
		return nil
	}
}

// requireReaderConsistent asserts the reader sees either nothing or a
// complete, digest-verified package matching want.
func requireReaderConsistent(t *testing.T, root, runID string, want Input) {
	t.Helper()
	pkg, err := Read(root, runID)
	if errors.Is(err, ErrNotPublished) {
		return
	}
	if err != nil {
		t.Fatalf("reader observed inconsistent state: %v", err)
	}
	if string(pkg.TestLog) != string(want.TestLog) ||
		string(pkg.Summary) != string(want.Summary) ||
		pkg.ExitCode != want.ExitCode {
		t.Fatalf("reader observed package content mismatch")
	}
}

func TestPublishAndRead(t *testing.T) {
	root := t.TempDir()
	in := sampleInput("run-1")

	m, err := NewPublisher(root, nil).Publish(in)
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if m.Digest == "" || len(m.Files) != 3 {
		t.Fatalf("unexpected manifest: %+v", m)
	}

	pkg, err := Read(root, "run-1")
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(pkg.TestLog) != string(in.TestLog) ||
		string(pkg.Summary) != string(in.Summary) ||
		pkg.ExitCode != in.ExitCode {
		t.Fatalf("round-trip content mismatch")
	}
	if pkg.Manifest.Digest != m.Digest {
		t.Fatalf("manifest digest changed between publish and read")
	}

	// Manifest must be the only commit marker; no staging files remain.
	entries, err := os.ReadDir(filepath.Join(root, "runs", "run-1"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if filepath.Ext(e.Name()) == ".tmp" {
			t.Fatalf("stale temp file left behind: %s", e.Name())
		}
	}
}

func TestRepublishIdempotent(t *testing.T) {
	root := t.TempDir()
	in := sampleInput("run-idem")

	m1, err := NewPublisher(root, nil).Publish(in)
	if err != nil {
		t.Fatalf("first Publish: %v", err)
	}
	m2, err := NewPublisher(root, nil).Publish(in)
	if err != nil {
		t.Fatalf("second Publish: %v", err)
	}
	if m1.Digest != m2.Digest {
		t.Fatalf("digest changed across idempotent republish")
	}
}

func TestConflictingDigestRejected(t *testing.T) {
	root := t.TempDir()
	in := sampleInput("run-conflict")
	if _, err := NewPublisher(root, nil).Publish(in); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	changed := in
	changed.ExitCode = 1
	changed.TestLog = []byte("FAIL\n")
	if _, err := NewPublisher(root, nil).Publish(changed); !errors.Is(err, ErrDigestConflict) {
		t.Fatalf("want ErrDigestConflict, got %v", err)
	}

	// Original package must remain intact and readable.
	pkg, err := Read(root, "run-conflict")
	if err != nil {
		t.Fatalf("Read after conflict: %v", err)
	}
	if pkg.ExitCode != 0 {
		t.Fatalf("published package mutated by rejected retry")
	}
}

// TestCrashRestartMatrix crashes the publisher at every fault point, checks
// the reader sees either nothing or a complete package, then restarts with a
// fresh Publisher and verifies the publish completes.
func TestCrashRestartMatrix(t *testing.T) {
	faultPoints := []string{"claim", "files", "verify", "manifest-staged", "manifest"}
	for _, fp := range faultPoints {
		t.Run(fp, func(t *testing.T) {
			root := t.TempDir()
			in := sampleInput("run-crash")

			crashed := NewPublisher(root, &Options{AfterOp: crashAt(fp)})
			if _, err := crashed.Publish(in); err == nil {
				t.Fatalf("expected crash error at %s", fp)
			}

			// After the crash: reader sees nothing or a complete package.
			requireReaderConsistent(t, root, "run-crash", in)

			// A retry with different content is rejected even mid-publish.
			changed := in
			changed.Summary = []byte(`{"passed":0,"failed":1}`)
			if _, err := NewPublisher(root, nil).Publish(changed); !errors.Is(err, ErrDigestConflict) {
				t.Fatalf("after crash at %s: want ErrDigestConflict, got %v", fp, err)
			}

			// Restart with the same content completes the publish.
			m, err := NewPublisher(root, nil).Publish(in)
			if err != nil {
				t.Fatalf("restart Publish after crash at %s: %v", fp, err)
			}
			pkg, err := Read(root, "run-crash")
			if err != nil {
				t.Fatalf("Read after restart: %v", err)
			}
			if pkg.Manifest.Digest != m.Digest ||
				string(pkg.TestLog) != string(in.TestLog) ||
				string(pkg.Summary) != string(in.Summary) ||
				pkg.ExitCode != in.ExitCode {
				t.Fatalf("package mismatch after restart at %s", fp)
			}
		})
	}
}

func TestReaderRejectsCorruption(t *testing.T) {
	root := t.TempDir()
	in := sampleInput("run-tamper")
	if _, err := NewPublisher(root, nil).Publish(in); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	runDir := filepath.Join(root, "runs", "run-tamper")
	if err := os.WriteFile(filepath.Join(runDir, TestLogFile), []byte("forged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Read(root, "run-tamper"); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("want ErrCorrupt for tampered file, got %v", err)
	}
}

func TestUnpublishedRunReadsAsAbsent(t *testing.T) {
	root := t.TempDir()
	if _, err := Read(root, "never-published"); !errors.Is(err, ErrNotPublished) {
		t.Fatalf("want ErrNotPublished, got %v", err)
	}

	// A run directory with only staged temp files is still unpublished.
	in := sampleInput("run-partial")
	crashed := NewPublisher(root, &Options{AfterOp: crashAt("manifest-staged")})
	if _, err := crashed.Publish(in); err == nil {
		t.Fatal("expected crash")
	}
	if _, err := Read(root, "run-partial"); !errors.Is(err, ErrNotPublished) {
		t.Fatalf("staged-but-uncommitted run: want ErrNotPublished, got %v", err)
	}
}

func TestInvalidRunID(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{"", ".", "..", "a/b", `a\b`, "a\x00b"} {
		in := sampleInput(id)
		if _, err := NewPublisher(root, nil).Publish(in); err == nil {
			t.Fatalf("Publish accepted invalid run ID %q", id)
		}
		if _, err := Read(root, id); err == nil {
			t.Fatalf("Read accepted invalid run ID %q", id)
		}
	}
}
