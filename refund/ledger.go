// Package refund 实现收款库的退款分摊逻辑。
//
// 规则：
//   - 退款按各账户原支付金额的比例分摊；
//   - 累计退款额采用“比例份额向下取整”，余分（remainder cents）按账户 ID
//     升序依次分配，每户至多一分；
//   - 每次退款只补“目标累计额 − 已退累计额”的差额，因此任意拆分序列的
//     最终各户退款一致（余分随累计额重算时，单户差额可能为负校正）；
//   - 请求 ID 幂等：同一 ID 金额一致则不再重复退款，金额不一致则拒绝；
//   - 累计退款总额不得超过原支付总额。
package refund

import (
	"errors"
	"fmt"
	"sort"
)

var (
	// ErrDuplicateRequest 表示请求 ID 已存在且金额不一致。
	ErrDuplicateRequest = errors.New("refund: duplicate request id with different amount")
	// ErrExceedsPayment 表示累计退款将超过原支付总额。
	ErrExceedsPayment = errors.New("refund: total refund exceeds original payment")
	// ErrInvalidAmount 表示退款金额非法（负数）。
	ErrInvalidAmount = errors.New("refund: amount must be non-negative")
)

// Account 记录一个收款账户的原支付份额（单位：分）。
type Account struct {
	ID   string
	Paid int64
}

// Ledger 是一笔收款的退款账本。
type Ledger struct {
	accounts      []Account // 按 ID 升序
	totalPaid     int64
	totalRefunded int64
	refunded      []int64          // 各账户已退累计额，与 accounts 对齐
	requests      map[string]int64 // requestID -> amount
}

// NewLedger 依据各账户原支付份额创建账本。账户 ID 必须唯一，份额非负，
// 且总份额必须为正。
func NewLedger(accounts []Account) (*Ledger, error) {
	if len(accounts) == 0 {
		return nil, errors.New("refund: ledger requires at least one account")
	}
	accs := make([]Account, len(accounts))
	copy(accs, accounts)
	sort.Slice(accs, func(i, j int) bool { return accs[i].ID < accs[j].ID })

	var total int64
	for i, a := range accs {
		if a.ID == "" {
			return nil, errors.New("refund: account id must not be empty")
		}
		if a.Paid < 0 {
			return nil, fmt.Errorf("refund: account %s has negative share", a.ID)
		}
		if i > 0 && accs[i-1].ID == a.ID {
			return nil, fmt.Errorf("refund: duplicate account id %q", a.ID)
		}
		total += a.Paid
	}
	if total <= 0 {
		return nil, errors.New("refund: total paid must be positive")
	}
	return &Ledger{
		accounts:  accs,
		totalPaid: total,
		refunded:  make([]int64, len(accs)),
		requests:  make(map[string]int64),
	}, nil
}

// allocate 计算累计退款总额为 total 时各账户应退的累计额：
// 先按比例向下取整，再把剩余的分按账户 ID 升序每户补一分。
func (l *Ledger) allocate(total int64) []int64 {
	shares := make([]int64, len(l.accounts))
	var distributed int64
	for i, a := range l.accounts {
		shares[i] = total * a.Paid / l.totalPaid
		distributed += shares[i]
	}
	for i, rem := 0, total-distributed; rem > 0; i, rem = i+1, rem-1 {
		shares[i]++
	}
	return shares
}

// Refund 发起一笔退款，返回本次各账户实际补退的差额（按账户 ID 升序）。
// 同一 requestID 重复调用且金额一致时为幂等操作，返回全零差额；
// 金额不一致返回 ErrDuplicateRequest。
func (l *Ledger) Refund(requestID string, amount int64) (map[string]int64, error) {
	if amount < 0 {
		return nil, ErrInvalidAmount
	}
	if prev, ok := l.requests[requestID]; ok {
		if prev != amount {
			return nil, fmt.Errorf("%w: request %q recorded %d, got %d",
				ErrDuplicateRequest, requestID, prev, amount)
		}
		return zeroDelta(l.accounts), nil
	}
	if l.totalRefunded+amount > l.totalPaid {
		return nil, fmt.Errorf("%w: paid %d, refunded %d, requested %d",
			ErrExceedsPayment, l.totalPaid, l.totalRefunded, amount)
	}

	target := l.allocate(l.totalRefunded + amount)
	delta := make(map[string]int64, len(l.accounts))
	for i, a := range l.accounts {
		delta[a.ID] = target[i] - l.refunded[i]
	}
	l.refunded = target
	l.totalRefunded += amount
	l.requests[requestID] = amount
	return delta, nil
}

// Refunded 返回各账户当前累计退款额（按账户 ID 升序）。
func (l *Ledger) Refunded() map[string]int64 {
	out := make(map[string]int64, len(l.accounts))
	for i, a := range l.accounts {
		out[a.ID] = l.refunded[i]
	}
	return out
}

// TotalRefunded 返回累计退款总额。
func (l *Ledger) TotalRefunded() int64 { return l.totalRefunded }

// TotalPaid 返回原支付总额。
func (l *Ledger) TotalPaid() int64 { return l.totalPaid }

func zeroDelta(accounts []Account) map[string]int64 {
	out := make(map[string]int64, len(accounts))
	for _, a := range accounts {
		out[a.ID] = 0
	}
	return out
}
