package rolelib

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func mustAddRoles(t *testing.T, l *Library, names ...string) {
	t.Helper()
	for _, n := range names {
		if err := l.AddRole(n); err != nil {
			t.Fatalf("AddRole(%q): %v", n, err)
		}
	}
}

func mustInherit(t *testing.T, l *Library, role, parent string) {
	t.Helper()
	if err := l.AddInheritance(role, parent); err != nil {
		t.Fatalf("AddInheritance(%q, %q): %v", role, parent, err)
	}
}

func TestInheritanceCycleRejected(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "a", "b", "c")
	mustInherit(t, l, "a", "b")
	mustInherit(t, l, "b", "c")
	if err := l.AddInheritance("c", "a"); err == nil {
		t.Fatal("expected cycle to be rejected")
	}
	if err := l.AddInheritance("a", "a"); err == nil {
		t.Fatal("expected self-inheritance to be rejected")
	}
	if err := l.AddInheritance("a", "b"); err != nil {
		t.Fatalf("duplicate edge should be a no-op: %v", err)
	}
}

func TestStaticExclusionDirect(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "dev", "ops")
	if err := l.AddStaticExclusion("dev", "ops"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("dev"); err != nil {
		t.Fatalf("grant dev: %v", err)
	}
	err := l.Grant("ops")
	var c *Conflict
	if !errors.As(err, &c) {
		t.Fatalf("expected *Conflict, got %v", err)
	}
	if c.Kind != Static || c.A != "dev" || c.B != "ops" {
		t.Fatalf("unexpected conflict: %+v", c)
	}
	if got := l.Held(); !reflect.DeepEqual(got, []string{"dev"}) {
		t.Fatalf("failed grant must not change held set, got %v", got)
	}
}

func TestStaticExclusionIndirectViaInheritance(t *testing.T) {
	l := New()
	// deploy -> cicd -> ops; auditor is statically exclusive with ops.
	mustAddRoles(t, l, "deploy", "cicd", "ops", "auditor")
	mustInherit(t, l, "deploy", "cicd")
	mustInherit(t, l, "cicd", "ops")
	if err := l.AddStaticExclusion("ops", "auditor"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("deploy"); err != nil {
		t.Fatalf("grant deploy: %v", err)
	}
	err := l.Grant("auditor")
	var c *Conflict
	if !errors.As(err, &c) {
		t.Fatalf("expected indirect conflict, got %v", err)
	}
	if c.Kind != Static {
		t.Fatalf("expected static conflict, got %v", c.Kind)
	}
	// The chain from deploy up to ops must be the full inheritance path.
	if !reflect.DeepEqual(c.ChainA, []string{"deploy", "cicd", "ops"}) &&
		!reflect.DeepEqual(c.ChainB, []string{"deploy", "cicd", "ops"}) {
		t.Fatalf("expected chain deploy->cicd->ops, got %+v", c)
	}
	if got := l.Held(); !reflect.DeepEqual(got, []string{"deploy"}) {
		t.Fatalf("held set changed after rejected grant: %v", got)
	}
}

func TestBatchGrantAtomic(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "a", "b", "x", "y")
	if err := l.AddStaticExclusion("x", "y"); err != nil {
		t.Fatal(err)
	}
	// Batch contains a conflicting pair; nothing may be granted.
	if err := l.Grant("a", "x", "b", "y"); err == nil {
		t.Fatal("expected batch grant to fail")
	}
	if got := l.Held(); len(got) != 0 {
		t.Fatalf("batch grant not atomic, held = %v", got)
	}
	// A clean batch succeeds as a whole.
	if err := l.Grant("a", "x", "b"); err != nil {
		t.Fatalf("clean batch: %v", err)
	}
	if got := l.Held(); !reflect.DeepEqual(got, []string{"a", "b", "x"}) {
		t.Fatalf("held = %v", got)
	}
}

func TestBatchGrantAtomicIndirectConflict(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "junior", "senior", "root", "viewer")
	mustInherit(t, l, "senior", "root")
	if err := l.AddStaticExclusion("root", "viewer"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("viewer"); err != nil {
		t.Fatal(err)
	}
	// senior indirectly inherits root, which conflicts with viewer.
	if err := l.Grant("junior", "senior"); err == nil {
		t.Fatal("expected indirect conflict in batch")
	}
	if got := l.Held(); !reflect.DeepEqual(got, []string{"viewer"}) {
		t.Fatalf("batch not atomic, held = %v", got)
	}
}

func TestDynamicExclusionSeparateFromStatic(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "dbread", "dbwrite")
	if err := l.AddDynamicExclusion("dbread", "dbwrite"); err != nil {
		t.Fatal(err)
	}
	// Dynamic exclusion does not prevent holding both roles.
	if err := l.Grant("dbread", "dbwrite"); err != nil {
		t.Fatalf("dynamic pair must be holdable together: %v", err)
	}
	if err := l.Activate("dbread"); err != nil {
		t.Fatal(err)
	}
	// Activating the second role fails and leaves the active set untouched.
	err := l.Activate("dbwrite")
	var c *Conflict
	if !errors.As(err, &c) || c.Kind != Dynamic {
		t.Fatalf("expected dynamic conflict, got %v", err)
	}
	if got := l.Active(); !reflect.DeepEqual(got, []string{"dbread"}) {
		t.Fatalf("active set changed after rejected activation: %v", got)
	}
	// After deactivating, the other role can be activated.
	if err := l.Deactivate("dbread"); err != nil {
		t.Fatal(err)
	}
	if err := l.Activate("dbwrite"); err != nil {
		t.Fatalf("activation after deactivation: %v", err)
	}
}

func TestDynamicExclusionIndirectViaInheritance(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "payroll-run", "payroll", "payroll-audit")
	mustInherit(t, l, "payroll-run", "payroll")
	if err := l.AddDynamicExclusion("payroll", "payroll-audit"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("payroll-run", "payroll-audit"); err != nil {
		t.Fatal(err)
	}
	if err := l.Activate("payroll-run"); err != nil {
		t.Fatal(err)
	}
	err := l.Activate("payroll-audit")
	var c *Conflict
	if !errors.As(err, &c) || c.Kind != Dynamic {
		t.Fatalf("expected indirect dynamic conflict, got %v", err)
	}
	if !reflect.DeepEqual(c.ChainA, []string{"payroll-run", "payroll"}) &&
		!reflect.DeepEqual(c.ChainB, []string{"payroll-run", "payroll"}) {
		t.Fatalf("expected chain payroll-run->payroll, got %+v", c)
	}
}

func TestActivateRequiresHold(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "admin", "base")
	mustInherit(t, l, "admin", "base")
	if err := l.Activate("admin"); err == nil {
		t.Fatal("activating an unheld role must fail")
	}
	if err := l.Grant("admin"); err != nil {
		t.Fatal(err)
	}
	// Inherited roles may be activated directly.
	if err := l.Activate("base"); err != nil {
		t.Fatalf("activating inherited role: %v", err)
	}
}

func TestRevokePrunesActive(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "admin", "base")
	mustInherit(t, l, "admin", "base")
	if err := l.Grant("admin"); err != nil {
		t.Fatal(err)
	}
	if err := l.Activate("admin", "base"); err != nil {
		t.Fatal(err)
	}
	if err := l.Revoke("admin"); err != nil {
		t.Fatal(err)
	}
	if got := l.Active(); len(got) != 0 {
		t.Fatalf("active roles not pruned after revoke: %v", got)
	}
}

func TestShortestConflictChain(t *testing.T) {
	l := New()
	// Two paths from leaf to top: leaf->mid1->mid2->top (len 4) and
	// leaf->direct->top (len 3). The shortest one must be reported.
	mustAddRoles(t, l, "leaf", "mid1", "mid2", "direct", "top", "other")
	mustInherit(t, l, "leaf", "mid1")
	mustInherit(t, l, "mid1", "mid2")
	mustInherit(t, l, "mid2", "top")
	mustInherit(t, l, "leaf", "direct")
	mustInherit(t, l, "direct", "top")
	if err := l.AddStaticExclusion("top", "other"); err != nil {
		t.Fatal(err)
	}
	if err := l.Grant("other"); err != nil {
		t.Fatal(err)
	}
	err := l.Grant("leaf")
	var c *Conflict
	if !errors.As(err, &c) {
		t.Fatalf("expected conflict, got %v", err)
	}
	var chain []string
	switch {
	case c.A == "top":
		chain = c.ChainA
	case c.B == "top":
		chain = c.ChainB
	default:
		t.Fatalf("conflict does not involve top: %+v", c)
	}
	want := []string{"leaf", "direct", "top"}
	if !reflect.DeepEqual(chain, want) {
		t.Fatalf("shortest chain = %v, want %v", chain, want)
	}
	// Error message must render the chain.
	if !strings.Contains(err.Error(), "leaf -> direct -> top") {
		t.Fatalf("error message missing chain: %v", err)
	}
}

func TestUnknownRoleErrors(t *testing.T) {
	l := New()
	mustAddRoles(t, l, "a")
	for _, err := range []error{
		l.AddInheritance("a", "ghost"),
		l.AddStaticExclusion("a", "ghost"),
		l.AddDynamicExclusion("ghost", "a"),
		l.Grant("ghost"),
		l.Revoke("ghost"),
		l.Activate("ghost"),
		l.Deactivate("ghost"),
	} {
		if err == nil {
			t.Fatal("expected unknown-role error")
		}
	}
}
