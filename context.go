package q197

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// 由调用方注入的命名上下文。组件只通过 Registry 解析上下文名称，
// 自身不发起任何网络请求。
var (
	ErrUnknownContext = errors.New("q197: unknown named context")
	ErrInvalidContext = errors.New("q197: invalid context definition")
	ErrUnknownTerm    = errors.New("q197: term is not mapped in the current scope")
	ErrTermDeleted    = errors.New("q197: term has been explicitly deleted")
	ErrAliasCycle     = errors.New("q197: alias expansion cycle detected")
	ErrKeyConflict    = errors.New("q197: expanded object keys conflict")
	ErrIncludeCycle   = errors.New("q197: named context include cycle detected")
)

// RawContext 是调用方注入的原始上下文文档。
//
//   - 键 "@vocab" 的值为 string 或 nil：string 设置默认词汇前缀，
//     nil 删除继承来的默认词汇前缀。
//   - 键 "@include" 的值为 string 或 []any：按顺序合入命名上下文。
//   - 其余键为词项定义。字符串值以 ":" 判定为绝对 IRI，否则视为
//     指向同一作用域另一词项的别名；nil 显式删除继承词项；
//     map[string]any 为结构化定义，支持 "@id" 与 "@context"。
type RawContext map[string]any

// Registry 保存调用方注入的命名上下文，并缓存编译后的不可变作用域。
// 缓存键同时包含父作用域与上下文名称，因此同一命名上下文在不同
// 父作用域下会得到独立、可复用的编译结果。
type Registry struct {
	mu       sync.RWMutex
	contexts map[string]RawContext
	cache    map[cacheKey]*Scope
}

type cacheKey struct {
	parent *Scope
	name   string
}

// NewRegistry 创建空注册表。
func NewRegistry() *Registry {
	return &Registry{
		contexts: make(map[string]RawContext),
		cache:    make(map[cacheKey]*Scope),
	}
}

// AddContext 注册（或替换）一个命名上下文。替换不会影响此前已经
// 编译并缓存的作用域，缓存一旦生成即不可变。
func (r *Registry) AddContext(name string, ctx RawContext) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.contexts[name] = ctx
}

// Scope 是编译后的不可变作用域。Scope 仅在 Registry.compile 内部构造，
// 构造完成后所有字段均不再变更；派生作用域通过复制 map 构建，
// 不会原地修改父作用域。
type Scope struct {
	registry *Registry
	parent   *Scope
	name     string
	vocab    string
	hasVocab bool
	terms    map[string]termDef
}

type termDef struct {
	iri          string
	alias        string
	contextChain []string
	deleted      bool
}

// Parent 返回父作用域，根作用域返回 nil。
func (s *Scope) Parent() *Scope { return s.parent }

// Name 返回编译该作用域所使用的上下文名称。
func (s *Scope) Name() string { return s.name }

// Compile 在父作用域 parent 之上编译命名上下文 name；parent 为 nil
// 时表示根作用域。相同 (parent, name) 组合始终返回同一个 *Scope。
func (r *Registry) Compile(name string, parent *Scope) (*Scope, error) {
	return r.compile(name, parent, nil)
}

func (r *Registry) compile(name string, parent *Scope, visiting []string) (*Scope, error) {
	r.mu.RLock()
	if cached, ok := r.cache[cacheKey{parent: parent, name: name}]; ok {
		r.mu.RUnlock()
		return cached, nil
	}
	raw, ok := r.contexts[name]
	r.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownContext, name)
	}

	for _, earlier := range visiting {
		if earlier == name {
			chain := append(append([]string(nil), visiting...), name)
			return nil, fmt.Errorf("%w: %s", ErrIncludeCycle, strings.Join(chain, " -> "))
		}
	}
	visiting = append(visiting, name)

	scope := &Scope{
		registry: r,
		parent:   parent,
		name:     name,
		terms:    make(map[string]termDef),
	}
	if parent != nil {
		scope.vocab = parent.vocab
		scope.hasVocab = parent.hasVocab
		for term, def := range parent.terms {
			scope.terms[term] = def
		}
	}

	// 先合入包含的上下文，再应用本上下文自身的定义，
	// 使本地定义可以覆盖或删除继承内容。
	if includes, exists := raw["@include"]; exists {
		names, err := stringList(includes)
		if err != nil {
			return nil, fmt.Errorf("%w: @include in %q: %v", ErrInvalidContext, name, err)
		}
		for _, included := range names {
			includedScope, err := r.compile(included, parent, visiting)
			if err != nil {
				return nil, err
			}
			scope.merge(includedScope)
		}
	}

	if vocab, exists := raw["@vocab"]; exists {
		switch value := vocab.(type) {
		case nil:
			scope.vocab = ""
			scope.hasVocab = false
		case string:
			scope.vocab = value
			scope.hasVocab = true
		default:
			return nil, fmt.Errorf("%w: @vocab in %q must be string or null", ErrInvalidContext, name)
		}
	}

	keys := make([]string, 0, len(raw))
	for key := range raw {
		if key != "@vocab" && key != "@include" {
			keys = append(keys, key)
		}
	}
	// 确定性的处理顺序仅影响报错稳定性；map 覆盖语义与顺序无关。
	sortStrings(keys)
	for _, term := range keys {
		if err := scope.applyDef(term, raw[term]); err != nil {
			return nil, fmt.Errorf("%w: term %q in %q: %v", ErrInvalidContext, term, name, err)
		}
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	key := cacheKey{parent: parent, name: name}
	if cached, ok := r.cache[key]; ok {
		return cached, nil
	}
	r.cache[key] = scope
	return scope, nil
}

// merge 将另一个作用域的扁平定义合入当前作用域。被合入作用域与
// 当前作用域共享同一父作用域，因此其 terms 已包含全部继承内容；
// 直接覆盖即得到正确的继承结果。
func (s *Scope) merge(other *Scope) {
	if other.hasVocab {
		s.vocab = other.vocab
		s.hasVocab = true
	}
	for term, def := range other.terms {
		s.terms[term] = def
	}
}

func (s *Scope) applyDef(term string, value any) error {
	if raw, ok := value.(RawContext); ok {
		value = map[string]any(raw)
	}
	switch value := value.(type) {
	case nil:
		// null 映射删除继承词项：写入删除标记，使别名链可以
		// 精确区分“未定义”与“显式删除”。
		s.terms[term] = termDef{deleted: true}
		return nil
	case string:
		if isAbsoluteIRI(value) {
			s.terms[term] = termDef{iri: value}
		} else {
			s.terms[term] = termDef{alias: value}
		}
		return nil
	case map[string]any:
		id, ok := value["@id"]
		if !ok {
			return errors.New("structured term definition requires @id")
		}
		idString, ok := id.(string)
		if !ok {
			return errors.New("@id must be a string")
		}
		def := termDef{}
		if isAbsoluteIRI(idString) {
			def.iri = idString
		} else {
			def.alias = idString
		}
		if scoped, exists := value["@context"]; exists {
			names, err := stringList(scoped)
			if err != nil {
				return err
			}
			registry := s.registry
			registry.mu.RLock()
			for _, nested := range names {
				if _, ok := registry.contexts[nested]; !ok {
					registry.mu.RUnlock()
					return fmt.Errorf("%w: %q", ErrUnknownContext, nested)
				}
			}
			registry.mu.RUnlock()
			def.contextChain = names
		}
		s.terms[term] = def
		return nil
	default:
		return errors.New("term definition must be string, null or object")
	}
}

// Resolve 按当前作用域把词项递归展开为绝对 IRI。别名在当前
// 作用域内递归解析；检测到环时返回包含完整展开链的错误。
func (s *Scope) Resolve(term string) (string, error) {
	chain := []string{term}
	seen := map[string]bool{term: true}
	current := term
	for {
		def, ok := s.terms[current]
		if !ok {
			return "", fmt.Errorf("%w: %q (chain: %s)", ErrUnknownTerm, term, strings.Join(chain, " -> "))
		}
		if def.deleted {
			return "", fmt.Errorf("%w: %q (chain: %s)", ErrTermDeleted, term, strings.Join(chain, " -> "))
		}
		if def.iri != "" {
			return def.iri, nil
		}
		next := def.alias
		chain = append(chain, next)
		if seen[next] {
			return "", fmt.Errorf("%w: %s", ErrAliasCycle, strings.Join(chain, " -> "))
		}
		seen[next] = true
		current = next
	}
}

// scopedContexts 返回词项最终绑定上的嵌套上下文名称链。
func (s *Scope) scopedContexts(term string) ([]string, bool) {
	def, ok := s.terms[term]
	if !ok || def.deleted {
		return nil, false
	}
	return def.contextChain, len(def.contextChain) > 0
}

// isAbsoluteIRI 以方案前缀判定绝对 IRI：第一个路径分隔符之前
// 存在 ":"，且其前至少有一个字符。本组件不访问网络，不做进一步校验。
func isAbsoluteIRI(value string) bool {
	if value == "" {
		return false
	}
	for index, r := range value {
		switch r {
		case ':', '/', '?', '#':
			return r == ':' && index > 0
		}
	}
	return false
}

func stringList(value any) ([]string, error) {
	switch value := value.(type) {
	case string:
		return []string{value}, nil
	case []any:
		result := make([]string, 0, len(value))
		for _, item := range value {
			text, ok := item.(string)
			if !ok {
				return nil, errors.New("context reference must be a string")
			}
			result = append(result, text)
		}
		return result, nil
	default:
		return nil, errors.New("context reference must be a string or string array")
	}
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j-1] > values[j]; j-- {
			values[j-1], values[j] = values[j], values[j-1]
		}
	}
}
