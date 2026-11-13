package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrDependencyNotPassed 标记规则因前置未通过而被跳过。
var ErrDependencyNotPassed = errors.New("dependency did not pass")

// Execute 按批执行计划：批内独立规则并行执行，
// 返回的结果始终按规则声明顺序稳定排列。
//
// 前置规则未通过（失败或被跳过）时，策略为 SkipOnDepFailure 的规则
// 标记为 StatusSkipped 且不执行；策略为 ContinueOnDepFailure 的规则
// 仍然执行，其结果由自身 Run 决定。被跳过的规则绝不是通过，
// 并会继续阻断其下游规则。
func (p *Plan) Execute(ctx context.Context) []Result {
	results := make([]Result, len(p.order))
	status := make(map[string]Status, len(p.order))

	for _, batch := range p.batches {
		var wg sync.WaitGroup
		for _, n := range batch {
			res := Result{RuleID: n.rule.ID, Produces: n.rule.Produces}
			results[n.index] = res

			var blockedBy string
			for _, dep := range n.rule.DependsOn {
				if status[dep] != StatusPassed {
					blockedBy = dep
					break
				}
			}
			if blockedBy != "" && n.rule.OnDepFailure == SkipOnDepFailure {
				res.Status = StatusSkipped
				res.Err = fmt.Errorf("%w: %q", ErrDependencyNotPassed, blockedBy)
				results[n.index] = res
				status[n.rule.ID] = StatusSkipped
				continue
			}

			wg.Add(1)
			go func(n *node, res *Result) {
				defer wg.Done()
				if err := n.rule.Run(ctx); err != nil {
					res.Status = StatusFailed
					res.Err = err
				} else {
					res.Status = StatusPassed
				}
			}(n, &results[n.index])
		}
		wg.Wait()
		for _, n := range batch {
			status[n.rule.ID] = results[n.index].Status
		}
	}
	return results
}

// Passed 报告结果是否为通过；被跳过不算通过。
func (r Result) Passed() bool { return r.Status == StatusPassed }
