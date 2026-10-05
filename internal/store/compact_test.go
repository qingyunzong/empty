package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// seedStore creates a store with live pages spread over several segments
// (multiple sessions) plus dead versions from overwrites.
func seedStore(t *testing.T, dir string) (generation uint64) {
	t.Helper()
	for session := 0; session < 3; session++ {
		s, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		putPages(t, s, uint64(session*10+1), uint64(session*10+10), "live")
		// Overwrites create reclaimable garbage inside the segments.
		putPages(t, s, uint64(session*10+1), uint64(session*10+5), "live")
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	return s.Generation()
}

func wantLivePages(t *testing.T, s *Store) {
	t.Helper()
	wantPages(t, s, 1, 30, "live")
}

// TestCrashRecoveryMatrix injects a power loss at every compaction
// boundary. After each crash, reopening must expose either the old or the
// new generation — fully intact in both cases — and the store must stay
// usable.
func TestCrashRecoveryMatrix(t *testing.T) {
	points := []struct {
		name      string
		point     FaultPoint
		committed bool // whether the new generation is visible after the crash
	}{
		{"BeforeCopy", FaultBeforeCopy, false},
		{"AfterCopy", FaultAfterCopy, false},
		{"AfterIndexFlush", FaultAfterIndexFlush, false},
		{"AfterCommit", FaultAfterCommit, true},
		{"DuringRetire", FaultDuringRetire, true},
	}
	for _, tc := range points {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			gen0 := seedStore(t, dir)

			s, err := Open(dir, WithFaultInjector(&FaultInjector{Point: tc.point}))
			if err != nil {
				t.Fatal(err)
			}
			if err := s.Compact(); !errors.Is(err, ErrCrash) {
				t.Fatalf("Compact err = %v, want ErrCrash", err)
			}
			s.Close() // best-effort cleanup of the crashed session

			// Power comes back: reopen and audit.
			s, err = Open(dir)
			if err != nil {
				t.Fatalf("reopen after crash: %v", err)
			}
			wantGen := gen0
			if tc.committed {
				wantGen = gen0 + 1
			}
			if s.Generation() != wantGen {
				t.Fatalf("generation = %d, want %d", s.Generation(), wantGen)
			}
			wantLivePages(t, s)

			report, err := Verify(dir)
			if err != nil {
				t.Fatal(err)
			}
			if !report.OK() {
				t.Fatalf("verify after crash: %v", report)
			}

			// The store keeps working: more puts and a clean compaction.
			putPages(t, s, 31, 35, "post-crash")
			if err := s.Compact(); err != nil {
				t.Fatalf("compact after recovery: %v", err)
			}
			wantLivePages(t, s)
			wantPages(t, s, 31, 35, "post-crash")
			if err := s.Close(); err != nil {
				t.Fatal(err)
			}

			report, err = Verify(dir)
			if err != nil {
				t.Fatal(err)
			}
			if !report.OK() {
				t.Fatalf("final verify: %v", report)
			}
		})
	}
}

// TestCompactReclaimsGarbage checks that after compaction the reclamation
// range covers everything but the compact segment.
func TestCompactReclaimsGarbage(t *testing.T) {
	dir := t.TempDir()
	seedStore(t, dir)

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Compact(); err != nil {
		t.Fatal(err)
	}
	wantLivePages(t, s)
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}

	segments := 0
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if _, ok := parseSegFileName(e.Name()); ok {
			segments++
		}
	}
	if segments != 1 {
		t.Fatalf("segments on disk = %d, want exactly 1 compact segment", segments)
	}

	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK() {
		t.Fatalf("verify: %v", report)
	}
	if report.Pages != 30 {
		t.Fatalf("pages = %d, want 30", report.Pages)
	}
}

// TestRecoveryCleansUncommittedGarbage simulates a crash between index
// flush and commit by hand, then checks recovery removes the debris.
func TestRecoveryCleansUncommittedGarbage(t *testing.T) {
	dir := t.TempDir()
	seedStore(t, dir)

	// Plant debris: an uncommitted segment, a future index log, a temp.
	debris := []string{segFileName(9001), indexFileName(9002), "idx-9003.log.tmp"}
	for _, name := range debris {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("junk"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	wantLivePages(t, s)

	for _, name := range debris {
		if fileExists(filepath.Join(dir, name)) {
			t.Fatalf("debris %s survived recovery", name)
		}
	}
	report, err := Verify(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !report.OK() {
		t.Fatalf("verify: %v", report)
	}
}
