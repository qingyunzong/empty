// Package formal 提供可嵌入服务网关的流量拆分组件。
//
// 组件按模型版本的百分比权重把请求分配到不同版本，支持 canary（金丝雀）
// 版本与 shadow（影子）版本，并通过替换配置实现回滚：回滚后只有新请求按新
// 配置分配，已经在途的请求在 Release 之前始终保持被路由时的版本。
package formal

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// Role 描述版本在流量拆分中的角色。
type Role int

const (
	// RoleStable 是稳定版本，按权重承接正式流量。
	RoleStable Role = iota
	// RoleCanary 是金丝雀版本，同样按权重承接正式流量，
	// 区别只在语义上，便于灰度统计与独立管理。
	RoleCanary
	// RoleShadow 是影子版本，只承接影子流量，不参与正式百分比分配。
	RoleShadow
)

// Version 描述一个模型版本及其在当前配置中的角色与权重。
type Version struct {
	ID     string
	Role   Role
	Weight int
}

// Config 是某一代流量分配配置。正式版本（stable/canary）的权重之和必须为 100，
// shadow 版本不参与权重求和。
type Config struct {
	Versions []Version
}

// Stats 是某一时刻的分配计数快照。
type Stats struct {
	// Primary 按版本记录正式（含 canary）请求计数。
	Primary map[string]int64
	// Shadow 按版本记录影子请求计数，影子流量不进入正式响应。
	Shadow map[string]int64
	// InFlight 按版本记录尚未 Release 的在途请求计数。
	InFlight map[string]int64
}

// 常见配置错误。
var (
	ErrEmptyConfig      = errors.New("formal: config has no versions")
	ErrEmptyVersionID   = errors.New("formal: version id must not be empty")
	ErrDuplicateVersion = errors.New("formal: duplicate version id")
	ErrNegativeWeight   = errors.New("formal: weight must be >= 0")
	ErrWeightsNotSum100 = errors.New("formal: primary weights must sum to 100")
	ErrShadowHasWeight  = errors.New("formal: shadow versions must have weight 0")
	ErrNoPrimaryVersion = errors.New("formal: config needs at least one non-shadow version")
)

// Validate 校验配置：正式版本权重守恒（合计 100），影子版本权重必须为 0。
func (c Config) Validate() error {
	if len(c.Versions) == 0 {
		return ErrEmptyConfig
	}
	seen := make(map[string]struct{}, len(c.Versions))
	sum := 0
	primaries := 0
	for _, v := range c.Versions {
		if v.ID == "" {
			return ErrEmptyVersionID
		}
		if _, ok := seen[v.ID]; ok {
			return fmt.Errorf("%w: %s", ErrDuplicateVersion, v.ID)
		}
		seen[v.ID] = struct{}{}
		if v.Weight < 0 {
			return fmt.Errorf("%w: %s=%d", ErrNegativeWeight, v.ID, v.Weight)
		}
		if v.Role == RoleShadow {
			if v.Weight != 0 {
				return fmt.Errorf("%w: %s", ErrShadowHasWeight, v.ID)
			}
			continue
		}
		primaries++
		sum += v.Weight
	}
	if primaries == 0 {
		return ErrNoPrimaryVersion
	}
	if sum != 100 {
		return fmt.Errorf("%w: got %d", ErrWeightsNotSum100, sum)
	}
	return nil
}

// versionState 保存单个版本的在线赤字分配状态。
type versionState struct {
	version Version
	// deficit 是在线最大余数法的赤字：deficit = w*n - 100*allocated，
	// 每来一个请求加 w，被选中后减 100。
	deficit int64
}

// Assignment 是一次路由决策。它在 Release 之前一直钉住被分配到的版本，
// 即使期间发生配置切换或回滚也不受影响。
type Assignment struct {
	versionID string
	gen       int
	splitter  *Splitter
	released  sync.Once
}

// VersionID 返回本次请求被分配到的正式版本。
func (a *Assignment) VersionID() string { return a.versionID }

// Release 标记请求完成，递减对应版本的在途计数。重复调用是幂等的，
// 因此回滚/切换与请求完成交错时不会重复计数。
func (a *Assignment) Release() {
	a.released.Do(func() { a.splitter.complete(a) })
}

// Splitter 是可嵌入网关的并发安全流量拆分器。零值不可用，请用 NewSplitter 构造。
type Splitter struct {
	mu       sync.Mutex
	gen      int
	config   Config
	active   []*versionState
	shadows  []string
	primary  map[string]int64
	shadow   map[string]int64
	inflight map[string]int64
}

// NewSplitter 用首代配置创建拆分器。
func NewSplitter(c Config) (*Splitter, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	s := &Splitter{
		primary:  map[string]int64{},
		shadow:   map[string]int64{},
		inflight: map[string]int64{},
	}
	s.apply(c)
	return s, nil
}

// apply 用新配置重建版本状态并把代数加一。调用方必须持有 mu（或在构造期独占）。
func (s *Splitter) apply(c Config) {
	s.gen++
	s.config = cloneConfig(c)
	s.active = make([]*versionState, 0, len(c.Versions))
	s.shadows = nil
	for _, v := range c.Versions {
		if v.Role == RoleShadow {
			s.shadows = append(s.shadows, v.ID)
			if _, ok := s.shadow[v.ID]; !ok {
				s.shadow[v.ID] = 0
			}
			continue
		}
		s.active = append(s.active, &versionState{version: v})
		if _, ok := s.primary[v.ID]; !ok {
			s.primary[v.ID] = 0
		}
		if _, ok := s.inflight[v.ID]; !ok {
			s.inflight[v.ID] = 0
		}
	}
}

// Route 为一个新请求选择正式版本，并同时返回全部影子版本。
// 路由完成后请求即计入正式版本与在途计数；影子版本只增加影子计数，
// 其响应不得作为正式响应返回。
func (s *Splitter) Route() (*Assignment, []string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 先按当前赤字选出本请求的归属。
	pick := 0
	for i := 1; i < len(s.active); i++ {
		cur, best := s.active[i], s.active[pick]
		// 平局时按权重决出，权重再相同则保持配置顺序，
		// 保证零权重版本永远不会抢占正式名额。
		if cur.deficit > best.deficit ||
			(cur.deficit == best.deficit && cur.version.Weight > best.version.Weight) {
			pick = i
		}
	}
	// 所有版本累计权重，选中版本消耗 100（一个正式名额）。
	for _, vs := range s.active {
		vs.deficit += int64(vs.version.Weight)
	}
	chosen := s.active[pick]
	chosen.deficit -= 100

	s.primary[chosen.version.ID]++
	s.inflight[chosen.version.ID]++
	a := &Assignment{
		versionID: chosen.version.ID,
		gen:       s.gen,
		splitter:  s,
	}
	for _, id := range s.shadows {
		s.shadow[id]++
	}
	return a, append([]string(nil), s.shadows...)
}

// complete 由 Assignment.Release 调用，幂等性由 sync.Once 保证。
func (s *Splitter) complete(a *Assignment) {
	s.mu.Lock()
	s.inflight[a.versionID]--
	s.mu.Unlock()
}

// UpdateConfig 切换到新配置（回滚也是一次配置替换）。切换只影响之后的新请求：
// 已有的 Assignment 仍然钉住原版本，其 Release 继续作用于原版本的在途计数。
// 新配置下赤字从零开始累计，保证新代数内部的比例守恒。
func (s *Splitter) UpdateConfig(c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	s.mu.Lock()
	s.apply(c)
	s.mu.Unlock()
	return nil
}

// Rollback 用历史/稳定配置执行回滚。语义与 UpdateConfig 相同：
// 仅新请求切换版本，在途请求保持原版本直到 Release。
func (s *Splitter) Rollback(c Config) error {
	return s.UpdateConfig(c)
}

// Generation 返回当前配置代数，每次成功的 UpdateConfig/Rollback 后递增。
func (s *Splitter) Generation() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gen
}

// CurrentConfig 返回当前配置的副本。
func (s *Splitter) CurrentConfig() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return cloneConfig(s.config)
}

// Stats 返回各类计数的快照。
func (s *Splitter) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := Stats{
		Primary:  make(map[string]int64, len(s.primary)),
		Shadow:   make(map[string]int64, len(s.shadow)),
		InFlight: make(map[string]int64, len(s.inflight)),
	}
	for k, v := range s.primary {
		out.Primary[k] = v
	}
	for k, v := range s.shadow {
		out.Shadow[k] = v
	}
	for k, v := range s.inflight {
		out.InFlight[k] = v
	}
	return out
}

func cloneConfig(c Config) Config {
	vs := make([]Version, len(c.Versions))
	copy(vs, c.Versions)
	return Config{Versions: vs}
}

// Handler 是按版本处理请求的可嵌入接口。
type Handler interface {
	Handle(ctx context.Context, versionID string, req any) (any, error)
}

// HandlerFunc 让普通函数满足 Handler。
type HandlerFunc func(ctx context.Context, versionID string, req any) (any, error)

// Handle 实现 Handler。
func (f HandlerFunc) Handle(ctx context.Context, versionID string, req any) (any, error) {
	return f(ctx, versionID, req)
}

// Dispatcher 在 Splitter 之上提供“正式 + 影子”派发：正式响应原样返回，
// 影子调用独立执行，其错误与结果永远不会影响正式响应。
type Dispatcher struct {
	splitter *Splitter
	handler  Handler

	async   bool
	wg      sync.WaitGroup
	closed  bool
	closeMu sync.Mutex
}

// DispatcherOption 调整 Dispatcher 的影子执行方式。
type DispatcherOption func(*Dispatcher)

// WithAsyncShadow 让影子调用在独立 goroutine 中执行（默认同步，便于嵌入方自行控制）。
// 异步模式下 Close 会等待全部在途影子调用结束。
func WithAsyncShadow() DispatcherOption {
	return func(d *Dispatcher) { d.async = true }
}

// NewDispatcher 创建派发器。
func NewDispatcher(s *Splitter, h Handler, opts ...DispatcherOption) *Dispatcher {
	d := &Dispatcher{splitter: s, handler: h}
	for _, opt := range opts {
		opt(d)
	}
	return d
}

// Decision 是一次派发的结果。
type Decision struct {
	Assignment *Assignment
	PrimaryID  string
	ShadowIDs  []string
	Response   any
	Err        error
	// ShadowErr 记录同步模式下各影子调用的错误；异步模式下不填充。
	ShadowErr map[string]error
}

// Dispatch 路由并处理请求。正式版本的结果作为正式响应；影子版本仅做比较，
// 其 panic 会被恢复为错误，绝不传播到正式调用链。
func (d *Dispatcher) Dispatch(ctx context.Context, req any) Decision {
	a, shadowIDs := d.splitter.Route()
	resp, err := d.handler.Handle(ctx, a.VersionID(), req)

	dec := Decision{
		Assignment: a,
		PrimaryID:  a.VersionID(),
		ShadowIDs:  shadowIDs,
		Response:   resp,
		Err:        err,
	}
	if len(shadowIDs) == 0 {
		return dec
	}
	if d.async {
		d.dispatchAsync(ctx, req, shadowIDs)
		return dec
	}
	dec.ShadowErr = d.runShadows(ctx, req, shadowIDs)
	return dec
}

func (d *Dispatcher) dispatchAsync(ctx context.Context, req any, shadowIDs []string) {
	d.closeMu.Lock()
	defer d.closeMu.Unlock()
	if d.closed {
		return
	}
	d.wg.Add(1)
	// 影子调用不得因为正式请求的 ctx 取消而被连带取消。
	shadowCtx := context.WithoutCancel(ctx)
	go func() {
		defer d.wg.Done()
		d.runShadows(shadowCtx, req, shadowIDs)
	}()
}

func (d *Dispatcher) runShadows(ctx context.Context, req any, shadowIDs []string) map[string]error {
	errs := make(map[string]error, len(shadowIDs))
	for _, id := range shadowIDs {
		errs[id] = d.invokeSafe(ctx, id, req)
	}
	return errs
}

func (d *Dispatcher) invokeSafe(ctx context.Context, versionID string, req any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("formal: shadow %s panicked: %v", versionID, r)
		}
	}()
	_, err = d.handler.Handle(ctx, versionID, req)
	return err
}

// Close 等待异步模式下尚未结束的影子调用。同步模式下立即返回。
func (d *Dispatcher) Close() {
	d.closeMu.Lock()
	d.closed = true
	d.closeMu.Unlock()
	d.wg.Wait()
}
