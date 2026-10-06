package refund

import (
	"errors"
	"fmt"
	"reflect"
	"testing"
)

func mustLedger(t *testing.T, accounts ...Account) *Ledger {
	t.Helper()
	l, err := NewLedger(accounts)
	if err != nil {
		t.Fatalf("NewLedger: %v", err)
	}
	return l
}

// 比例份额向下取整 + 余分按账户 ID 升序分配。
func TestAllocateFloorAndRemainderByAccountID(t *testing.T) {
	l := mustLedger(t,
		Account{ID: "c", Paid: 300},
		Account{ID: "a", Paid: 100},
		Account{ID: "b", Paid: 200},
	)
	// 100 按 1:2:3 分摊 -> 16/33/50，余 1 分给 ID 最小的 a。
	got, err := l.Refund("r1", 100)
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	want := map[string]int64{"a": 17, "b": 33, "c": 50}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delta = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(l.Refunded(), want) {
		t.Fatalf("refunded = %v, want %v", l.Refunded(), want)
	}
}

// 余分依次分给 ID 最小的前几个账户。
func TestRemainderDistributedByAccountIDOrder(t *testing.T) {
	l := mustLedger(t,
		Account{ID: "z", Paid: 1},
		Account{ID: "m", Paid: 1},
		Account{ID: "a", Paid: 1},
	)
	got, err := l.Refund("r1", 2)
	if err != nil {
		t.Fatalf("Refund: %v", err)
	}
	want := map[string]int64{"a": 1, "m": 1, "z": 0}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("delta = %v, want %v", got, want)
	}
}

// 后次退款只补差额：分两次退与一次退到位结果一致。
func TestSubsequentRefundTopsUpDifference(t *testing.T) {
	accounts := []Account{{ID: "a", Paid: 100}, {ID: "b", Paid: 200}, {ID: "c", Paid: 300}}

	l1 := mustLedger(t, accounts...)
	if _, err := l1.Refund("r1", 100); err != nil {
		t.Fatalf("Refund r1: %v", err)
	}
	d2, err := l1.Refund("r2", 150)
	if err != nil {
		t.Fatalf("Refund r2: %v", err)
	}

	l2 := mustLedger(t, accounts...)
	if _, err := l2.Refund("r1", 250); err != nil {
		t.Fatalf("Refund single: %v", err)
	}

	if !reflect.DeepEqual(l1.Refunded(), l2.Refunded()) {
		t.Fatalf("split refunded = %v, single = %v", l1.Refunded(), l2.Refunded())
	}
	// 差额之和等于第二次退款额。
	var sum int64
	for _, d := range d2 {
		sum += d
	}
	if sum != 150 {
		t.Fatalf("top-up delta sums to %d, want 150", sum)
	}
}

// 请求 ID 重复：金额一致幂等，金额不一致拒绝。
func TestDuplicateRequestID(t *testing.T) {
	l := mustLedger(t, Account{ID: "a", Paid: 100}, Account{ID: "b", Paid: 100})

	if _, err := l.Refund("r1", 40); err != nil {
		t.Fatalf("Refund: %v", err)
	}
	// 同 ID 同金额：幂等，不再补退。
	delta, err := l.Refund("r1", 40)
	if err != nil {
		t.Fatalf("duplicate same amount should be idempotent, got %v", err)
	}
	for id, d := range delta {
		if d != 0 {
			t.Fatalf("idempotent replay moved %d for %s", d, id)
		}
	}
	if l.TotalRefunded() != 40 {
		t.Fatalf("total refunded = %d, want 40", l.TotalRefunded())
	}
	// 同 ID 不同金额：拒绝。
	if _, err := l.Refund("r1", 41); !errors.Is(err, ErrDuplicateRequest) {
		t.Fatalf("err = %v, want ErrDuplicateRequest", err)
	}
	if l.TotalRefunded() != 40 {
		t.Fatalf("rejected refund changed total to %d", l.TotalRefunded())
	}
}

// 累计退款总额不得超过原支付总额。
func TestRefundMustNotExceedPayment(t *testing.T) {
	l := mustLedger(t, Account{ID: "a", Paid: 50}, Account{ID: "b", Paid: 50})

	if _, err := l.Refund("r1", 100); err != nil {
		t.Fatalf("full refund: %v", err)
	}
	if _, err := l.Refund("r2", 1); !errors.Is(err, ErrExceedsPayment) {
		t.Fatalf("err = %v, want ErrExceedsPayment", err)
	}
	if _, err := l.Refund("r3", -1); !errors.Is(err, ErrInvalidAmount) {
		t.Fatalf("err = %v, want ErrInvalidAmount", err)
	}
	// 全额退款后各户退款等于原支付。
	want := map[string]int64{"a": 50, "b": 50}
	if !reflect.DeepEqual(l.Refunded(), want) {
		t.Fatalf("refunded = %v, want %v", l.Refunded(), want)
	}
}

// 枚举所有拆分退款序列，验证最终各户退款一致。
func TestEnumerateSplitSequencesConverge(t *testing.T) {
	accounts := []Account{
		{ID: "a", Paid: 7},
		{ID: "b", Paid: 13},
		{ID: "c", Paid: 29},
		{ID: "d", Paid: 51},
	}
	const total = 37   // 退款总额（分）
	const maxParts = 4 // 最多拆成 4 笔

	base := mustLedger(t, accounts...)
	if _, err := base.Refund("r0", total); err != nil {
		t.Fatalf("baseline refund: %v", err)
	}
	want := base.Refunded()

	var seq []int64
	var cases int
	var walk func(remaining int64)
	walk = func(remaining int64) {
		if remaining == 0 {
			cases++
			l := mustLedger(t, accounts...)
			var cum int64
			for i, amt := range seq {
				delta, err := l.Refund(fmt.Sprintf("r%d", i), amt)
				if err != nil {
					t.Fatalf("seq %v: refund #%d: %v", seq, i, err)
				}
				// 差额合计等于本次金额（余分重算时单户差额可能为负校正）。
				var sum int64
				for _, d := range delta {
					sum += d
				}
				if sum != amt {
					t.Fatalf("seq %v: delta sum %d != amount %d", seq, sum, amt)
				}
				cum += amt
				if l.TotalRefunded() != cum {
					t.Fatalf("seq %v: total %d != %d", seq, l.TotalRefunded(), cum)
				}
			}
			if got := l.Refunded(); !reflect.DeepEqual(got, want) {
				t.Fatalf("seq %v: refunded = %v, want %v", seq, got, want)
			}
			return
		}
		if len(seq) == maxParts {
			return
		}
		for amt := int64(1); amt <= remaining; amt++ {
			seq = append(seq, amt)
			walk(remaining - amt)
			seq = seq[:len(seq)-1]
		}
	}
	walk(total)

	if cases == 0 {
		t.Fatal("no sequences enumerated")
	}
	t.Logf("verified %d split sequences", cases)
}

// 枚举拆分序列退完全部款项，最终各户退款等于原支付。
func TestEnumerateFullRefundSequences(t *testing.T) {
	accounts := []Account{
		{ID: "a", Paid: 3},
		{ID: "b", Paid: 5},
		{ID: "c", Paid: 8},
	}
	var total int64
	for _, a := range accounts {
		total += a.Paid
	}
	want := map[string]int64{"a": 3, "b": 5, "c": 8}

	var seq []int64
	var walk func(remaining int64)
	walk = func(remaining int64) {
		if remaining == 0 {
			l := mustLedger(t, accounts...)
			for i, amt := range seq {
				if _, err := l.Refund(fmt.Sprintf("r%d", i), amt); err != nil {
					t.Fatalf("seq %v: %v", seq, err)
				}
			}
			if got := l.Refunded(); !reflect.DeepEqual(got, want) {
				t.Fatalf("seq %v: refunded = %v, want %v", seq, got, want)
			}
			return
		}
		for amt := int64(1); amt <= remaining; amt++ {
			seq = append(seq, amt)
			walk(remaining - amt)
			seq = seq[:len(seq)-1]
		}
	}
	walk(total)
}

func TestNewLedgerValidation(t *testing.T) {
	if _, err := NewLedger(nil); err == nil {
		t.Fatal("empty accounts should fail")
	}
	if _, err := NewLedger([]Account{{ID: "a", Paid: 0}}); err == nil {
		t.Fatal("zero total should fail")
	}
	if _, err := NewLedger([]Account{{ID: "a", Paid: 1}, {ID: "a", Paid: 2}}); err == nil {
		t.Fatal("duplicate id should fail")
	}
	if _, err := NewLedger([]Account{{ID: "a", Paid: -1}}); err == nil {
		t.Fatal("negative share should fail")
	}
}
