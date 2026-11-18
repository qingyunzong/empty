package formal

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// errInjected 表示测试注入的一次超时/网络失败。
var errInjected = errors.New("formal-test: injected transport timeout")

// crashSentinel 由崩溃钩子抛出，用于在单进程内模拟节点宕机；
// 抛出前 WAL 已完成追加，因此重建节点后能真实重放到崩溃前的状态。
var crashSentinel = errors.New("formal-test: simulated crash")

// flakyRM 在 ResourceManager 外包一层可故障注入、可重启的参与者。
type flakyRM struct {
	mu sync.Mutex

	id    ID
	wal   LogStore
	hook  func(Phase, Record)
	inner *ResourceManager

	prepareFails int
	commitFails  int
	abortFails   int

	prepareCalls int
	commitCalls  int
	abortCalls   int
}

func newFlakyRM(t *testing.T, id ID, hook func(Phase, Record)) *flakyRM {
	t.Helper()
	wal := NewMemWAL(nil)
	f := &flakyRM{id: id, wal: wal, hook: hook}
	rm, err := NewResourceManager(ResourceManagerConfig{ID: id, Log: wal, CrashHook: f.dispatchHook()})
	if err != nil {
		t.Fatalf("new resource manager %s: %v", id, err)
	}
	f.inner = rm
	return f
}

// dispatchHook 返回始终转发到外层最新 hook 的闭包，重启后依然生效。
func (f *flakyRM) dispatchHook() func(Phase, Record) {
	return func(phase Phase, rec Record) {
		f.mu.Lock()
		hook := f.hook
		f.mu.Unlock()
		if hook != nil {
			hook(phase, rec)
		}
	}
}

// restart 模拟参与者进程崩溃后带原 WAL 重启，内存状态完全由日志重放重建。
func (f *flakyRM) restart(t *testing.T) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	rm, err := NewResourceManager(ResourceManagerConfig{ID: f.id, Log: f.wal, CrashHook: f.dispatchHook()})
	if err != nil {
		t.Fatalf("restart resource manager %s: %v", f.id, err)
	}
	f.inner = rm
}

func (f *flakyRM) ID() ID { return f.id }

func (f *flakyRM) Prepare(ctx context.Context, tx TxID) (Vote, error) {
	f.mu.Lock()
	f.prepareCalls++
	if f.prepareFails > 0 {
		f.prepareFails--
		f.mu.Unlock()
		return VoteNo, errInjected
	}
	inner := f.inner
	f.mu.Unlock()
	return inner.Prepare(ctx, tx)
}

func (f *flakyRM) Commit(ctx context.Context, tx TxID) error {
	f.mu.Lock()
	f.commitCalls++
	if f.commitFails > 0 {
		f.commitFails--
		f.mu.Unlock()
		return errInjected
	}
	inner := f.inner
	f.mu.Unlock()
	return inner.Commit(ctx, tx)
}

func (f *flakyRM) Abort(ctx context.Context, tx TxID) error {
	f.mu.Lock()
	f.abortCalls++
	if f.abortFails > 0 {
		f.abortFails--
		f.mu.Unlock()
		return errInjected
	}
	inner := f.inner
	f.mu.Unlock()
	return inner.Abort(ctx, tx)
}

// state 读取参与者重放后的本地事务状态。
func (f *flakyRM) state(t *testing.T, tx TxID) Outcome {
	t.Helper()
	f.mu.Lock()
	inner := f.inner
	f.mu.Unlock()
	out, err := inner.Query(context.Background(), tx)
	if err != nil {
		t.Fatalf("query participant %s: %v", f.id, err)
	}
	return out
}

// rmLog 读取参与者 WAL 副本。
func (f *flakyRM) rmLog(t *testing.T) []Record {
	t.Helper()
	f.mu.Lock()
	wal := f.wal
	f.mu.Unlock()
	recs, err := wal.ReadAll()
	if err != nil {
		t.Fatalf("read participant wal: %v", err)
	}
	return recs
}

// testCluster 聚合一次测试所需的协调者与参与者。
type testCluster struct {
	t          *testing.T
	rms        []*flakyRM
	coWal      *MemWAL
	cfg        CoordinatorConfig
	current    *Coordinator
	crash      Phase
	crashFired bool
}

func newTestCluster(t *testing.T, n int) *testCluster {
	t.Helper()
	var rms []*flakyRM
	var parts []Participant
	for i := 0; i < n; i++ {
		rm := newFlakyRM(t, ID("rm-"+string(rune('a'+i))), nil)
		rms = append(rms, rm)
		parts = append(parts, rm)
	}
	coWal := NewMemWAL(nil)
	cl := &testCluster{t: t, rms: rms, coWal: coWal}
	cl.cfg = CoordinatorConfig{
		ID:           "coordinator",
		Log:          coWal,
		Participants: parts,
		MaxAttempts:  6,
		RetryBackoff: time.Millisecond,
	}
	cl.start()
	return cl
}

// start 构建（或重建）协调者，构造期间自动执行 WAL 重放恢复。
func (cl *testCluster) start() {
	cl.t.Helper()
	if cl.crash != PhaseUnknown && !cl.crashFired {
		point := cl.crash
		cl.cfg.CrashHook = func(phase Phase, _ Record) {
			if phase == point {
				cl.crashFired = true
				cl.crash = PhaseUnknown
				cl.cfg.CrashHook = nil
				panic(crashSentinel)
			}
		}
	}
	co, err := NewCoordinator(context.Background(), cl.cfg)
	if err != nil {
		cl.t.Fatalf("start coordinator: %v", err)
	}
	cl.current = co
}

// crashAt 安装一次性协调者崩溃钩子：目标阶段日志落盘后抛出崩溃异常。
func (cl *testCluster) crashAt(point Phase) {
	cl.t.Helper()
	cl.crash = point
	cl.crashFired = false
	cl.start()
}

// runWithCrash 运行事务并把模拟崩溃转化为「重启后重跑」，返回最终决议。
func (cl *testCluster) runWithCrash(tx TxID) (outcome Outcome, crashed bool) {
	cl.t.Helper()
	runOnce := func() (Outcome, bool) {
		didCrash := false
		func() {
			defer func() {
				if r := recover(); r != nil {
					if !errors.Is(r.(error), crashSentinel) {
						cl.t.Fatalf("unexpected panic: %v", r)
					}
					didCrash = true
				}
			}()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			outcome, _ = cl.current.Run(ctx, tx)
		}()
		return outcome, didCrash
	}

	outcome, crashed = runOnce()
	if !crashed {
		return outcome, false
	}
	// 重启重放日志后，钩子已被清除；重跑同一事务走幂等恢复路径并正常收尾。
	cl.start()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	outcome, err := cl.current.Run(ctx, tx)
	if err != nil {
		cl.t.Fatalf("re-run after crash recovery: %v", err)
	}
	return outcome, true
}

// coLog 读取协调者 WAL 副本并校验协议不变量。
func (cl *testCluster) coLog() []Record {
	cl.t.Helper()
	recs, err := cl.coWal.ReadAll()
	if err != nil {
		cl.t.Fatalf("read coordinator wal: %v", err)
	}
	if err := AssertLogInvariants(recs); err != nil {
		cl.t.Fatalf("coordinator wal invariant violated: %v", err)
	}
	return recs
}

// assertUniform 核对所有参与者对同一事务的最终状态唯一且等于期望决议。
func (cl *testCluster) assertUniform(tx TxID, want Outcome) {
	cl.t.Helper()
	for _, rm := range cl.rms {
		if got := rm.state(cl.t, tx); got != want {
			cl.t.Fatalf("participant %s state = %s, want %s", rm.id, got, want)
		}
	}
}
