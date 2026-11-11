package q197

import (
	"errors"
	"fmt"
	"sort"
)

// Expand 以命名上下文 rootContext 作为根作用域展开 JSON 树 value。
//
// 展开规则：
//   - 对象的每个键先在当前作用域解析为绝对 IRI；已是绝对 IRI 的
//     键保持原样。两个键展开到同一 IRI 时拒绝整个对象，不做覆盖。
//   - 词项带嵌套 @context 时，其值在派生子作用域中展开。
//   - 数组保持元素顺序，逐元素在同一作用域中展开。
//   - 字符串及其它标量值原样返回。
//
// 输入树不会被修改；返回值使用新建的 map/slice 承载。
func (r *Registry) Expand(rootContext string, value any) (any, error) {
	root, err := r.Compile(rootContext, nil)
	if err != nil {
		return nil, err
	}
	return r.expand(value, root)
}

// ExpandWithScope 与 Expand 相同，但允许调用方指定已编译的父作用域。
func (r *Registry) ExpandWithScope(scope *Scope, value any) (any, error) {
	if scope == nil {
		return nil, fmt.Errorf("%w: nil scope", ErrInvalidContext)
	}
	return r.expand(value, scope)
}

func (r *Registry) expand(value any, scope *Scope) (any, error) {
	switch value := value.(type) {
	case map[string]any:
		return r.expandObject(value, scope)
	case []any:
		result := make([]any, len(value))
		for index, item := range value {
			expanded, err := r.expand(item, scope)
			if err != nil {
				return nil, err
			}
			result[index] = expanded
		}
		return result, nil
	default:
		// 字符串、数字、布尔、nil 等标量原样保留。
		return value, nil
	}
}

func (r *Registry) expandObject(object map[string]any, scope *Scope) (map[string]any, error) {
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	expandedKeys := make(map[string]string, len(keys))
	for _, key := range keys {
		iri, err := resolveKey(scope, key)
		if err != nil {
			return nil, err
		}
		if previous, conflict := expandedKeys[iri]; conflict {
			return nil, fmt.Errorf("%w: %q and %q both expand to %q",
				ErrKeyConflict, previous, key, iri)
		}
		expandedKeys[iri] = key
	}

	result := make(map[string]any, len(keys))
	for _, key := range keys {
		iri := iriForKey(scope, key)
		childScope := scope
		if nested, ok := scope.scopedContexts(key); ok {
			compiled, err := r.compileChain(nested, scope)
			if err != nil {
				return nil, err
			}
			childScope = compiled
		}
		expandedValue, err := r.expand(object[key], childScope)
		if err != nil {
			return nil, err
		}
		result[iri] = expandedValue
	}
	return result, nil
}

func resolveKey(scope *Scope, key string) (string, error) {
	if isAbsoluteIRI(key) {
		return key, nil
	}
	iri, err := scope.Resolve(key)
	if err == nil {
		return iri, nil
	}
	if scope.hasVocab && isUnknownOrDeleted(err) {
		return scope.vocab + key, nil
	}
	return "", err
}

func iriForKey(scope *Scope, key string) string {
	iri, err := resolveKey(scope, key)
	if err != nil {
		// expandObject 已在前置阶段解析过全部键，不会走到这里。
		panic(err)
	}
	return iri
}

func isUnknownOrDeleted(err error) bool {
	return errors.Is(err, ErrUnknownTerm) || errors.Is(err, ErrTermDeleted)
}

func (r *Registry) compileChain(names []string, base *Scope) (*Scope, error) {
	scope := base
	var err error
	for _, name := range names {
		scope, err = r.Compile(name, scope)
		if err != nil {
			return nil, err
		}
	}
	return scope, nil
}
