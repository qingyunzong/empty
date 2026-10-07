// Package failscope 提供按作用域叠加的故障注入规则。
//
// 规则通过 context 沿调用链传递：WithRules 在父作用域之上叠加一个
// 内层作用域，同名规则内层优先；离开作用域（包括 panic 后）只需回到
// 父 context，父规则自然恢复。context 不可变，因此并发调用各自持有
// 自己的作用域链，互不污染。
//
// 每条规则为一次性：首次命中后即耗尽，Rule.Hits 记录实际命中次数。
package failscope

import (
	"context"
	"sync/atomic"
)

// Rule 是一条一次性故障注入规则：命中一次后耗尽。
type Rule struct {
	name string
	err  error
	// armed 为 1 表示可命中，命中后 CAS 置 0（耗尽）。
	armed atomic.Int32
	hits  atomic.Int64
}

// NewRule 创建一条名为 name、命中时返回 err 的一次性规则。
func NewRule(name string, err error) *Rule {
	r := &Rule{name: name, err: err}
	r.armed.Store(1)
	return r
}

// Name 返回规则名。
func (r *Rule) Name() string { return r.name }

// Hits 返回该规则的实际命中次数（命中账）。
func (r *Rule) Hits() int64 { return r.hits.Load() }

// scope 是一层作用域，parent 指向外层作用域，形成单向链。
type scope struct {
	parent *scope
	rules  map[string]*Rule
}

type scopeKey struct{}

func scopeFrom(ctx context.Context) *scope {
	sc, _ := ctx.Value(scopeKey{}).(*scope)
	return sc
}

// WithRules 在 ctx 上叠加一个内层作用域并返回新的 context。
// 同名规则内层优先（遮蔽外层）；原 ctx 不受影响，因此函数返回、
// 或 panic 被 recover 后继续使用原 ctx，即恢复父规则。
func WithRules(ctx context.Context, rules ...*Rule) context.Context {
	sc := &scope{parent: scopeFrom(ctx), rules: make(map[string]*Rule, len(rules))}
	for _, r := range rules {
		sc.rules[r.name] = r
	}
	return context.WithValue(ctx, scopeKey{}, sc)
}

// Inject 检查注入点 name 是否命中故障规则。
// 沿作用域链由内向外查找，首个包含 name 的作用域生效（内层优先）：
//   - 规则未耗尽：原子地认领并返回其错误，命中计数加一；
//   - 规则已耗尽：返回 nil，且不回退到外层同名规则（内层遮蔽）。
func Inject(ctx context.Context, name string) error {
	for sc := scopeFrom(ctx); sc != nil; sc = sc.parent {
		r, ok := sc.rules[name]
		if !ok {
			continue
		}
		if r.armed.CompareAndSwap(1, 0) {
			r.hits.Add(1)
			return r.err
		}
		return nil
	}
	return nil
}

// Report 输出自 ctx 可见规则的实际命中账：规则名 -> 命中次数。
// 同名规则只统计最内层可见的那条（与 Inject 的遮蔽语义一致）。
func Report(ctx context.Context) map[string]int64 {
	report := make(map[string]int64)
	for sc := scopeFrom(ctx); sc != nil; sc = sc.parent {
		for name, r := range sc.rules {
			if _, seen := report[name]; !seen {
				report[name] = r.Hits()
			}
		}
	}
	return report
}
