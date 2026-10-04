package materiallib

import (
	"errors"
	"sync"
)

// 发布流程中的故障注入点。
const (
	FaultAfterAttemptDir = "after_attempt_dir" // 创建本次尝试目录之后
	FaultAfterFiles      = "after_files"       // 写入全部数据文件之后
	FaultAfterManifest   = "after_manifest"    // 写入清单之后
	FaultAfterVerify     = "after_verify"      // 全量核验通过之后
	FaultBeforePointer   = "before_pointer"    // 切换 current 指针之前
	FaultAfterPointer    = "after_pointer"     // 切换 current 指针之后
)

// ErrInjected 是故障注入触发时返回的错误。
var ErrInjected = errors.New("materiallib: injected fault")

// FaultInjector 按注入点名称触发故障，用于测试发布路径上的各类中断。
type FaultInjector struct {
	mu        sync.Mutex
	remaining map[string]int // -1 表示永久生效
}

func NewFaultInjector() *FaultInjector {
	return &FaultInjector{remaining: make(map[string]int)}
}

// Fail 使指定注入点永久失败，直到 Clear。
func (f *FaultInjector) Fail(point string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.remaining[point] = -1
}

// FailOnce 使指定注入点仅失败一次。
func (f *FaultInjector) FailOnce(point string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.remaining[point] = 1
}

func (f *FaultInjector) Clear(point string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.remaining, point)
}

func (f *FaultInjector) ClearAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.remaining = make(map[string]int)
}

func (f *FaultInjector) check(point string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	n, ok := f.remaining[point]
	if !ok {
		return nil
	}
	if n > 0 {
		if n == 1 {
			delete(f.remaining, point)
		} else {
			f.remaining[point] = n - 1
		}
	}
	return ErrInjected
}
