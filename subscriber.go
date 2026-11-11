package q150

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// 默认重连等待时间（毫秒），可被服务端 retry 字段覆盖。
const DefaultRetryMillis = 3000

// ResumeStore 是恢复 ID 的持久化接口，由调用方注入。
//
// 实现必须保证持久化成功返回后，后续 Load 能读到该值。空 ID 表示
// 清除恢复标记（对应 SSE 的空 id 字段）。
type ResumeStore interface {
	Load(ctx context.Context) (id string, ok bool, err error)
	Save(ctx context.Context, id string) error
}

// Stream 是一次 SSE 连接的可读正文流。
type Stream interface {
	io.ReadCloser
}

// DialFunc 建立一次 SSE 连接。lastEventID 为已确认的恢复 ID，
// 为空时不应携带 Last-Event-ID 头。实现负责返回响应正文流，
// 连接失败时返回错误，由订阅器按等待策略重试。
type DialFunc func(ctx context.Context, lastEventID string) (Stream, error)

// Config 配置 Subscriber。
type Config struct {
	// URL 是事件流地址；提供自定义 Dial 时可留空。
	URL string
	// HTTPClient 供默认拨号器使用，nil 时使用 http.DefaultClient。
	HTTPClient *http.Client
	// Header 附加到默认拨号器的请求上。
	Header http.Header
	// Dial 自定义拨号逻辑；nil 时基于 URL 构造标准 SSE 请求。
	Dial DialFunc
	// Store 保存已确认的恢复 ID，必填。
	Store ResumeStore
	// DefaultRetry 是首次及服务端未给建议时的重连等待，0 使用默认值。
	DefaultRetry time.Duration

	// onWait 仅供测试观察重连等待行为。
	onWait func(d time.Duration)
}

// Subscriber 是可嵌入客户端的 SSE 订阅组件。
//
// 语义保证：
//   - 一次只交付一个待确认事件，调用 Next 取得事件后泵循环阻塞，
//     直到 Ack 成功或运行结束；
//   - 只有 Ack 成功把恢复 ID 写入注入存储后，才会继续读取后续事件；
//   - Ack 返回错误表示持久化失败，该事件仍是当前待确认事件，
//     不会被跳过，重连后会从已确认 ID 之后重新投递；
//   - 断线重连携带已确认 ID，并沿用服务端最近一次 retry 建议；
//   - 每次连接的正文流都会被关闭，包括取消与重连并发发生时。
type Subscriber struct {
	cfg          Config
	dial         DialFunc
	defaultRetry time.Duration

	runOnce sync.Once
	done    chan struct{}
	runErr  error

	ctx    context.Context
	cancel context.CancelFunc

	retryMu sync.Mutex
	events  chan Event
	acks    chan ackRequest
}

type ackRequest struct {
	resp chan error
}

// NewSubscriber 校验配置并构造订阅器。
func NewSubscriber(cfg Config) (*Subscriber, error) {
	if cfg.Store == nil {
		return nil, errors.New("q150: Config.Store is required")
	}
	dial := cfg.Dial
	if dial == nil {
		if cfg.URL == "" {
			return nil, errors.New("q150: Config.URL or Config.Dial is required")
		}
		dial = defaultDialer(cfg)
	}
	retry := cfg.DefaultRetry
	if retry <= 0 {
		retry = DefaultRetryMillis * time.Millisecond
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Subscriber{
		cfg:          cfg,
		dial:         dial,
		defaultRetry: retry,
		done:         make(chan struct{}),
		ctx:          ctx,
		cancel:       cancel,
		events:       make(chan Event),
		acks:         make(chan ackRequest),
	}, nil
}

// Run 启动订阅循环并阻塞直到 ctx 取消或发生不可恢复错误。
// 每个 Subscriber 只能运行一次。
func (s *Subscriber) Run(ctx context.Context) error {
	err := errAlreadyRun
	s.runOnce.Do(func() {
		err = s.run(ctx)
	})
	return err
}

var errAlreadyRun = errors.New("q150: subscriber already run")

func (s *Subscriber) run(ctx context.Context) error {
	defer close(s.done)
	// 外部 ctx 取消与内部 Close 共用一个取消信号，所有连接随之关闭。
	stopCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		select {
		case <-stopCtx.Done():
			s.cancel()
		case <-s.ctx.Done():
			stop()
		}
	}()

	id, _, err := s.cfg.Store.Load(stopCtx)
	if err != nil {
		s.runErr = fmt.Errorf("q150: load resume id: %w", err)
		return s.runErr
	}

	for {
		if err := stopCtx.Err(); err != nil {
			s.runErr = err
			return err
		}

		stream, err := s.dial(stopCtx, id)
		if err != nil {
			if stopCtx.Err() != nil {
				s.runErr = stopCtx.Err()
				return s.runErr
			}
			if !sleepWithContext(stopCtx, s.retryWait(), s.cfg.onWait) {
				s.runErr = stopCtx.Err()
				return s.runErr
			}
			continue
		}

		managed := newManagedStream(stream)
		// 取消发生在任何时刻（包括重连等待与读取阻塞）都关闭正文流。
		watchDone := make(chan struct{})
		go func() {
			select {
			case <-stopCtx.Done():
				managed.Close()
			case <-watchDone:
			}
		}()

		nextID, pumpErr := s.pump(stopCtx, managed, id)
		managed.Close()
		close(watchDone)
		id = nextID
		if stopCtx.Err() != nil {
			s.runErr = stopCtx.Err()
			return s.runErr
		}
		_ = pumpErr // EOF 与读错误均按断线处理，等待后重连
		if !sleepWithContext(stopCtx, s.retryWait(), s.cfg.onWait) {
			s.runErr = stopCtx.Err()
			return s.runErr
		}
	}
}

// pump 处理单条连接，返回连接结束时已确认的恢复 ID。
//
// 事件通过 s.events 交付后，泵循环停在 ack 等待上，保证同一时刻
// 只有一个待确认事件，且未确认事件不会被后续读取跳过。
func (s *Subscriber) pump(ctx context.Context, stream Stream, confirmedID string) (string, error) {
	id := confirmedID
	decoder := NewDecoder(
		func(event Event) {
			select {
			case s.events <- event:
			case <-ctx.Done():
				return
			}
			for {
				select {
				case req := <-s.acks:
					if saveErr := s.cfg.Store.Save(ctx, event.LastEventID); saveErr != nil {
						req.resp <- saveErr
						continue // 持久化失败：事件仍待确认，不推进
					}
					id = event.LastEventID
					req.resp <- nil
					return
				case <-ctx.Done():
					return
				}
			}
		},
		func(millis int) {
			// 服务端建议的等待时间在重连间保留。
			s.setRetry(time.Duration(millis) * time.Millisecond)
		},
	)

	buf := make([]byte, 4096)
	for {
		n, err := stream.Read(buf)
		if n > 0 {
			if _, writeErr := decoder.Write(buf[:n]); writeErr != nil {
				return id, writeErr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				_ = decoder.Close()
			}
			return id, err
		}
	}
}

// Next 返回下一个待确认事件。调用方必须调用 Ack 确认后才能收到
// 后续事件。ctx 取消时返回 ctx 中的错误，待确认事件不受影响。
func (s *Subscriber) Next(ctx context.Context) (Event, error) {
	select {
	case event := <-s.events:
		return event, nil
	case <-ctx.Done():
		return Event{}, ctx.Err()
	case <-s.done:
		return Event{}, s.runErr
	}
}

// Ack 确认当前事件：把事件的恢复 ID 持久化到注入存储。
//
// 返回非 nil 错误表示持久化失败，事件仍未确认，可重新调用 Ack；
// 空 ID 会以空字符串调用 Store.Save，由存储实现清除恢复标记。
func (s *Subscriber) Ack(ctx context.Context) error {
	req := ackRequest{resp: make(chan error, 1)}
	select {
	case s.acks <- req:
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return s.runErr
	}
	select {
	case err := <-req.resp:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-s.done:
		return s.runErr
	}
}

// Done 在运行循环结束后关闭。
func (s *Subscriber) Done() <-chan struct{} { return s.done }

// Err 返回 Run 结束的原因；未结束时为 nil。
func (s *Subscriber) Err() error {
	select {
	case <-s.done:
		return s.runErr
	default:
		return nil
	}
}

// Close 停止订阅循环。
func (s *Subscriber) Close() { s.cancel() }

func (s *Subscriber) retryWait() time.Duration {
	s.retryMu.Lock()
	defer s.retryMu.Unlock()
	return s.defaultRetry
}

func (s *Subscriber) setRetry(d time.Duration) {
	s.retryMu.Lock()
	defer s.retryMu.Unlock()
	s.defaultRetry = d
}

func sleepWithContext(ctx context.Context, d time.Duration, onWait func(time.Duration)) bool {
	if onWait != nil {
		onWait(d)
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func defaultDialer(cfg Config) DialFunc {
	client := cfg.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	return func(ctx context.Context, lastEventID string) (Stream, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.URL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("Accept", "text/event-stream")
		req.Header.Set("Cache-Control", "no-cache")
		for key, values := range cfg.Header {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
		if lastEventID != "" {
			req.Header.Set("Last-Event-ID", lastEventID)
		}
		resp, err := client.Do(req)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, fmt.Errorf("q150: unexpected SSE status %d", resp.StatusCode)
		}
		mediaType := resp.Header.Get("Content-Type")
		if idx := strings.IndexByte(mediaType, ';'); idx >= 0 {
			mediaType = mediaType[:idx]
		}
		if strings.ToLower(strings.TrimSpace(mediaType)) != "text/event-stream" {
			resp.Body.Close()
			return nil, fmt.Errorf("q150: unexpected content type %q", resp.Header.Get("Content-Type"))
		}
		return resp.Body, nil
	}
}
