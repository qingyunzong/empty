package authlib

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func openTemp(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "wal.log")
	s, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s, path
}

func reopen(t *testing.T, s *Store, path string) *Store {
	t.Helper()
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	ns, err := Open(path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	return ns
}

func mustRemaining(t *testing.T, s *Store, token string, want int) {
	t.Helper()
	got, err := s.Remaining(token)
	if err != nil {
		t.Fatalf("Remaining: %v", err)
	}
	if got != want {
		t.Fatalf("remaining = %d, want %d", got, want)
	}
}

func mustEffects(t *testing.T, s *Store, want int64) {
	t.Helper()
	if got := s.Effects(); got != want {
		t.Fatalf("effects = %d, want %d", got, want)
	}
}

// 基本语义：一个令牌允许 k 次整数动作，扣次与业务提交同事务生效。
func TestBasicDeductAndEffect(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if err := s.Issue("tok", 3); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := s.Use("tok", "tx1", 2, 10); err != nil {
		t.Fatalf("Use: %v", err)
	}
	mustRemaining(t, s, "tok", 1)
	mustEffects(t, s, 10)
	if err := s.Use("tok", "tx2", 1, 5); err != nil {
		t.Fatalf("Use: %v", err)
	}
	mustRemaining(t, s, "tok", 0)
	mustEffects(t, s, 15)
}

// 失败不扣：额度不足、未知令牌、非法数量、撤销后使用，均不扣次不计效果。
func TestFailureDoesNotDeduct(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if err := s.Issue("tok", 2); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	cases := []struct {
		name string
		err  error
		call func() error
	}{
		{"insufficient", ErrInsufficient, func() error { return s.Use("tok", "tx-a", 3, 1) }},
		{"unknown token", ErrUnknownToken, func() error { return s.Use("ghost", "tx-b", 1, 1) }},
		{"invalid amount", ErrInvalidAmount, func() error { return s.Use("tok", "tx-c", 0, 1) }},
		{"revoke unknown", ErrUnknownToken, func() error { return s.Revoke("ghost") }},
	}
	for _, c := range cases {
		if err := c.call(); !errors.Is(err, c.err) {
			t.Fatalf("%s: err = %v, want %v", c.name, err, c.err)
		}
	}
	if err := s.Revoke("tok"); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if err := s.Use("tok", "tx-d", 1, 1); !errors.Is(err, ErrRevoked) {
		t.Fatalf("use after revoke: err = %v, want %v", err, ErrRevoked)
	}
	mustRemaining(t, s, "tok", 2) // 全程未扣
	mustEffects(t, s, 0)
}

// 重复 ID 不再扣：同一 txID 第二次起返回 ErrDuplicate，状态不变。
func TestDuplicateIDNotDeductedAgain(t *testing.T) {
	s, path := openTemp(t)
	defer s.Close()
	if err := s.Issue("tok", 5); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := s.Use("tok", "tx1", 2, 7); err != nil {
		t.Fatalf("Use: %v", err)
	}
	for i := 0; i < 3; i++ {
		if err := s.Use("tok", "tx1", 2, 7); !errors.Is(err, ErrDuplicate) {
			t.Fatalf("retry %d: err = %v, want %v", i, err, ErrDuplicate)
		}
	}
	mustRemaining(t, s, "tok", 3)
	mustEffects(t, s, 7)
	// 重启后幂等键仍然有效。
	s = reopen(t, s, path)
	if err := s.Use("tok", "tx1", 2, 7); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("retry after restart: err = %v, want %v", err, ErrDuplicate)
	}
	mustRemaining(t, s, "tok", 3)
	mustEffects(t, s, 7)
}

// 崩溃注入：在指定崩溃点 panic 模拟进程崩溃。
func crashAt(s *Store, point CrashPoint) {
	s.SetCrashHook(func(p CrashPoint) {
		if p == point {
			panic("simulated crash at " + string(p))
		}
	})
}

func useExpectCrash(s *Store, token, txID string, n, effect int) {
	defer func() { _ = recover() }()
	_ = s.Use(token, txID, n, effect)
}

// 崩溃点 BeforeWrite：日志未写，恢复后不扣次、不计效果。
func TestCrashBeforeWrite(t *testing.T) {
	s, path := openTemp(t)
	if err := s.Issue("tok", 4); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	crashAt(s, BeforeWrite)
	useExpectCrash(s, "tok", "tx1", 2, 9)
	s = reopen(t, s, path)
	defer s.Close()
	mustRemaining(t, s, "tok", 4)
	mustEffects(t, s, 0)
	// txID 未提交，可以重试并成功。
	if err := s.Use("tok", "tx1", 2, 9); err != nil {
		t.Fatalf("retry Use: %v", err)
	}
	mustRemaining(t, s, "tok", 2)
	mustEffects(t, s, 9)
}

// 崩溃点 BeforeSync：记录已写但未 fsync。模拟断电丢失未同步数据
// （截断到写入前的大小），恢复后不扣次、不计效果。
func TestCrashBeforeSyncUnsyncedLost(t *testing.T) {
	s, path := openTemp(t)
	if err := s.Issue("tok", 4); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat: %v", err)
	}
	durableSize := st.Size()
	crashAt(s, BeforeSync)
	useExpectCrash(s, "tok", "tx1", 2, 9)
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// 模拟断电：未 fsync 的字节丢失。
	if err := os.Truncate(path, durableSize); err != nil {
		t.Fatalf("Truncate: %v", err)
	}
	s, err = Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer s.Close()
	mustRemaining(t, s, "tok", 4)
	mustEffects(t, s, 0)
}

// 崩溃点 AfterSync：日志事务已持久化但内存状态未应用。
// 恢复后扣次与业务效果精确生效一次，且重放 txID 幂等。
func TestCrashAfterSyncBeforeApply(t *testing.T) {
	s, path := openTemp(t)
	if err := s.Issue("tok", 4); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	crashAt(s, AfterSync)
	useExpectCrash(s, "tok", "tx1", 2, 9)
	s = reopen(t, s, path)
	defer s.Close()
	mustRemaining(t, s, "tok", 2) // 扣次与效果同事务恢复
	mustEffects(t, s, 9)
	if err := s.Use("tok", "tx1", 2, 9); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("retry after crash: err = %v, want %v", err, ErrDuplicate)
	}
	mustRemaining(t, s, "tok", 2)
	mustEffects(t, s, 9)
}

// 撕裂尾部：日志末尾出现半条记录时，恢复应忽略并截断，后续写入正常。
func TestTornTailIgnored(t *testing.T) {
	s, path := openTemp(t)
	if err := s.Issue("tok", 4); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if err := s.Use("tok", "tx1", 1, 3); err != nil {
		t.Fatalf("Use: %v", err)
	}
	if err := s.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// 追加半条记录模拟撕裂写。
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatalf("OpenFile: %v", err)
	}
	full := encodeRecord(record{TxID: "tx2", Token: "tok", Op: opCommit, N: 2, Effect: 5})
	if _, err := f.Write(full[:len(full)/2]); err != nil {
		t.Fatalf("Write: %v", err)
	}
	f.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatalf("Open with torn tail: %v", err)
	}
	defer s.Close()
	mustRemaining(t, s, "tok", 3) // 只有 tx1 生效
	mustEffects(t, s, 3)
	// 撕裂部分被截断，tx2 可重新提交。
	if err := s.Use("tok", "tx2", 2, 5); err != nil {
		t.Fatalf("Use after torn recovery: %v", err)
	}
	mustRemaining(t, s, "tok", 1)
	mustEffects(t, s, 8)
}

// 并发重复请求：N 个 goroutine 用同一 txID 抢提交，恰好成功一次。
func TestConcurrentDuplicateRequests(t *testing.T) {
	s, _ := openTemp(t)
	defer s.Close()
	if err := s.Issue("tok", 10); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	const goroutines = 32
	var wg sync.WaitGroup
	var mu sync.Mutex
	results := make(map[error]int)
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			err := s.Use("tok", "same-tx", 1, 4)
			mu.Lock()
			results[err]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if results[nil] != 1 {
		t.Fatalf("successes = %d, want 1 (results: %v)", results[nil], results)
	}
	if results[ErrDuplicate] != goroutines-1 {
		t.Fatalf("duplicates = %d, want %d", results[ErrDuplicate], goroutines-1)
	}
	mustRemaining(t, s, "tok", 9)
	mustEffects(t, s, 4)
}

// 并发不同 txID 超额竞争：恰好 k 次成功，剩余为 0，效果计数等于成功次数之和。
func TestConcurrentExhaustion(t *testing.T) {
	s, path := openTemp(t)
	const k = 20
	if err := s.Issue("tok", k); err != nil {
		t.Fatalf("Issue: %v", err)
	}
	const goroutines = 50
	var wg sync.WaitGroup
	var okCount int64
	var mu sync.Mutex
	for i := 0; i < goroutines; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.Use("tok", fmt.Sprintf("tx-%d", i), 1, 1); err == nil {
				mu.Lock()
				okCount++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	if okCount != k {
		t.Fatalf("successes = %d, want %d", okCount, k)
	}
	mustRemaining(t, s, "tok", 0)
	mustEffects(t, s, k)
	// 重启后核对：剩余次与效果计数从日志精确恢复。
	s = reopen(t, s, path)
	defer s.Close()
	mustRemaining(t, s, "tok", 0)
	mustEffects(t, s, k)
}

// 撤销与提交按锁内次序：并发 Use 与 Revoke，凡成功的提交
// 其日志记录必在 revoke 记录之前；revoke 之后的 Use 全部失败。
func TestRevokeCommitLockOrder(t *testing.T) {
	for trial := 0; trial < 20; trial++ {
		s, path := openTemp(t)
		const k = 8
		if err := s.Issue("tok", k); err != nil {
			t.Fatalf("Issue: %v", err)
		}
		const users = 16
		var wg sync.WaitGroup
		succeeded := make(map[string]bool)
		var mu sync.Mutex
		start := make(chan struct{})
		for i := 0; i < users; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				if err := s.Use("tok", fmt.Sprintf("tx-%d", i), 1, 1); err == nil {
					mu.Lock()
					succeeded[fmt.Sprintf("tx-%d", i)] = true
					mu.Unlock()
				}
			}(i)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_ = s.Revoke("tok")
		}()
		close(start)
		wg.Wait()

		// 不变量 1：成功数 + 剩余数 == k。
		rem, err := s.Remaining("tok")
		if err != nil {
			t.Fatalf("Remaining: %v", err)
		}
		if len(succeeded)+rem != k {
			t.Fatalf("trial %d: succeeded(%d)+remaining(%d) != %d", trial, len(succeeded), rem, k)
		}
		// 不变量 2：效果计数 == 成功提交数。
		if s.Effects() != int64(len(succeeded)) {
			t.Fatalf("trial %d: effects = %d, want %d", trial, s.Effects(), len(succeeded))
		}
		// 不变量 3：日志中所有 commit 都出现在 revoke 之前（锁内次序）。
		if err := s.Close(); err != nil {
			t.Fatalf("Close: %v", err)
		}
		assertCommitsBeforeRevoke(t, path, len(succeeded))
		// 不变量 4：恢复后状态一致，且撤销后无法再用。
		s, err = Open(path)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		mustRemaining(t, s, "tok", rem)
		mustEffects(t, s, int64(len(succeeded)))
		if err := s.Use("tok", "tx-after", 1, 1); !errors.Is(err, ErrRevoked) {
			t.Fatalf("trial %d: use after revoke = %v, want %v", trial, err, ErrRevoked)
		}
		s.Close()
	}
}

// assertCommitsBeforeRevoke 重放日志，验证 commit 与 revoke 的相对次序，
// 且 commit 条数等于成功数。
func assertCommitsBeforeRevoke(t *testing.T, path string, wantCommits int) {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("Open log: %v", err)
	}
	defer f.Close()
	revokedSeen := false
	commits := 0
	for {
		rec, ok, err := readRecord(f)
		if err != nil {
			t.Fatalf("readRecord: %v", err)
		}
		if !ok {
			break
		}
		switch rec.Op {
		case opCommit:
			commits++
			if revokedSeen {
				t.Fatalf("commit %q appears after revoke in log", rec.TxID)
			}
		case opRevoke:
			revokedSeen = true
		}
	}
	if commits != wantCommits {
		t.Fatalf("log commits = %d, want %d", commits, wantCommits)
	}
	if !revokedSeen {
		t.Fatalf("revoke record missing from log")
	}
}
