package scheduler

import (
	"strings"
	"testing"
)

func validProblem() Problem {
	return uniformProblem(4, 4, 0)
}

func validSchedule() Schedule {
	return Schedule{{0, 1}, {0, 2}, {1, 2}, {0, 1}}
}

func TestCheckAcceptsValidSchedule(t *testing.T) {
	if err := Check(validProblem(), validSchedule()); err != nil {
		t.Fatalf("expected valid schedule, got %v", err)
	}
}

func TestCheckRejectsViolations(t *testing.T) {
	cases := []struct {
		name    string
		mutate  func(p *Problem, s *Schedule)
		wantErr string
	}{
		{
			name: "wrong length",
			mutate: func(p *Problem, s *Schedule) {
				*s = (*s)[:3]
			},
			wantErr: "has 3 slots, want 4",
		},
		{
			name: "person index out of range",
			mutate: func(p *Problem, s *Schedule) {
				(*s)[0] = Pair{0, 7}
			},
			wantErr: "out of range",
		},
		{
			name: "same person twice",
			mutate: func(p *Problem, s *Schedule) {
				(*s)[1] = Pair{0, 0}
			},
			wantErr: "same person twice",
		},
		{
			name: "unordered pair",
			mutate: func(p *Problem, s *Schedule) {
				(*s)[1] = Pair{2, 0}
			},
			wantErr: "not ordered",
		},
		{
			name: "unqualified person",
			mutate: func(p *Problem, s *Schedule) {
				p.Qualified[2][1] = false
			},
			wantErr: "not qualified",
		},
		{
			name: "adjacent slots share nobody",
			mutate: func(p *Problem, s *Schedule) {
				(*s)[1] = Pair{2, 3}
			},
			wantErr: "share no person",
		},
		{
			name: "consecutive limit exceeded",
			mutate: func(p *Problem, s *Schedule) {
				*s = Schedule{{0, 1}, {0, 1}, {0, 1}, {0, 1}}
			},
			wantErr: "consecutive slots",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := validProblem()
			s := append(Schedule(nil), validSchedule()...)
			tc.mutate(&p, &s)
			err := Check(p, s)
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tc.wantErr)
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("error %q does not contain %q", err, tc.wantErr)
			}
		})
	}
}

func TestCheckRejectsInvalidProblem(t *testing.T) {
	p := validProblem()
	p.NumSlots = MaxSlots + 1
	if err := Check(p, validSchedule()); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestCheckBoundaryConsecutiveRun(t *testing.T) {
	// A run of exactly MaxConsec slots is allowed; one more is not.
	p := uniformProblem(3, 4, 0)
	okSched := Schedule{{0, 1}, {0, 2}, {0, 2}, {1, 2}}
	if err := Check(p, okSched); err != nil {
		t.Fatalf("run of %d should be accepted: %v", MaxConsec, err)
	}
	badSched := Schedule{{0, 1}, {0, 1}, {0, 1}, {0, 1}}
	if err := Check(p, badSched); err == nil {
		t.Fatalf("run of %d should be rejected", MaxConsec+1)
	}
}
