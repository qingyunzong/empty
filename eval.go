package dataeng

import (
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
)

// Options controls polynomial expansion.
type Options struct {
	// MaxTerms limits the number of monomials in the result. A value of
	// Unlimited disables the check. Zero permits only the zero polynomial.
	MaxTerms int
}

// Compile expands e into a canonical sparse polynomial. A monomial budget may
// be supplied as a single trailing int; with no budget, expansion is
// unlimited. If the result contains more monomials than the budget, Compile
// returns a nil polynomial and a *BudgetError: the expansion is unclosed and
// is never silently truncated.
func Compile(e *Expr, maxTerms ...int) (*Polynomial, error) {
	limit, err := resolveLimit(maxTerms)
	if err != nil {
		return nil, err
	}
	return compile(e, limit)
}

// CompileOptions is Compile with an explicit Options value.
func CompileOptions(e *Expr, opts Options) (*Polynomial, error) {
	if opts.MaxTerms < Unlimited {
		return nil, ErrInvalidBudget
	}
	return compile(e, opts.MaxTerms)
}

// CompileWithBudget is Compile with a required monomial budget.
func CompileWithBudget(e *Expr, maxTerms int) (*Polynomial, error) {
	return compile(e, maxTerms)
}

// Eval is an alias for Compile.
func Eval(e *Expr, maxTerms ...int) (*Polynomial, error) {
	return Compile(e, maxTerms...)
}

// Expand is an alias for Compile.
func Expand(e *Expr, maxTerms ...int) (*Polynomial, error) {
	return Compile(e, maxTerms...)
}

// ToPolynomial is an alias for Compile.
func ToPolynomial(e *Expr, maxTerms ...int) (*Polynomial, error) {
	return Compile(e, maxTerms...)
}

// EvalUnlimited expands e without a monomial limit.
func EvalUnlimited(e *Expr) (*Polynomial, error) {
	return compile(e, Unlimited)
}

func resolveLimit(maxTerms []int) (int, error) {
	switch len(maxTerms) {
	case 0:
		return Unlimited, nil
	case 1:
		if maxTerms[0] < Unlimited {
			return 0, ErrInvalidBudget
		}
		return maxTerms[0], nil
	default:
		return 0, ErrInvalidBudget
	}
}

// Validate checks the expression DAG for nil nodes, invalid variable IDs, and
// cycles.
func Validate(e *Expr) error {
	_, _, err := inspect(e)
	return err
}

// Variables returns the sorted variable IDs occurring in e without expanding
// the polynomial.
func Variables(e *Expr) ([]string, error) {
	_, variables, err := inspect(e)
	if err != nil {
		return nil, err
	}
	return variables, nil
}

type evalFrame struct {
	node *Expr
	next int
}

// inspect validates the graph and returns a postorder suitable for bottom-up
// evaluation plus the sorted list of variables.
func inspect(root *Expr) ([]*Expr, []string, error) {
	if root == nil {
		return nil, nil, ErrNilExpression
	}

	const (
		visiting uint8 = 1
		visited  uint8 = 2
	)
	state := make(map[*Expr]uint8)
	variables := make(map[string]struct{})
	order := make([]*Expr, 0)
	stack := []evalFrame{{node: root}}
	state[root] = visiting

	for len(stack) > 0 {
		frame := &stack[len(stack)-1]
		node := frame.node

		if frame.next == 0 {
			switch node.kind {
			case KindVar:
				if err := ValidateVariableID(node.id); err != nil {
					return nil, nil, err
				}
				variables[node.id] = struct{}{}
			case KindUnion, KindJoin:
				if len(node.args) == 0 {
					return nil, nil, ErrNilExpression
				}
			case KindZero, KindOne:
			default:
				return nil, nil, ErrNilExpression
			}
		}

		if frame.next < len(node.args) {
			child := node.args[frame.next]
			frame.next++
			if child == nil {
				return nil, nil, ErrNilExpression
			}
			switch state[child] {
			case visiting:
				return nil, nil, ErrCycle
			case visited:
				continue
			default:
				state[child] = visiting
				stack = append(stack, evalFrame{node: child})
			}
			continue
		}

		state[node] = visited
		order = append(order, node)
		stack = stack[:len(stack)-1]
	}

	ids := make([]string, 0, len(variables))
	for id := range variables {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return order, ids, nil
}

type sparseTerm struct {
	exponents   []int
	coefficient *big.Int
}

type sparsePoly struct {
	terms map[string]*sparseTerm
}

func newSparsePoly() *sparsePoly {
	return &sparsePoly{terms: make(map[string]*sparseTerm)}
}

func exponentKey(exponents []int) string {
	if len(exponents) == 0 {
		return ""
	}
	var b strings.Builder
	b.Grow(len(exponents) * 3)
	for i, exponent := range exponents {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.Itoa(exponent))
	}
	return b.String()
}

type evaluator struct {
	varIndex  map[string]int
	variables []string
	limit     int
	memo      map[*Expr]*sparsePoly
}

func compile(root *Expr, limit int) (*Polynomial, error) {
	if limit < Unlimited {
		return nil, ErrInvalidBudget
	}
	order, variables, err := inspect(root)
	if err != nil {
		return nil, err
	}
	ev := &evaluator{
		varIndex:  make(map[string]int, len(variables)),
		variables: variables,
		limit:     limit,
		memo:      make(map[*Expr]*sparsePoly, len(order)),
	}
	for i, id := range variables {
		ev.varIndex[id] = i
	}

	for _, node := range order {
		poly, err := ev.evalNode(node)
		if err != nil {
			return nil, err
		}
		ev.memo[node] = poly
	}

	result := ev.memo[root]
	return ev.render(result), nil
}

func (ev *evaluator) budgetError(observed int) error {
	return &BudgetError{Limit: ev.limit, Observed: observed}
}

func (ev *evaluator) checkBudget(count int) error {
	if ev.limit != Unlimited && count > ev.limit {
		return ev.budgetError(count)
	}
	return nil
}

func (ev *evaluator) evalNode(node *Expr) (*sparsePoly, error) {
	switch node.kind {
	case KindVar:
		exponents := make([]int, len(ev.variables))
		exponents[ev.varIndex[node.id]] = 1
		term := &sparseTerm{
			exponents:   exponents,
			coefficient: big.NewInt(1),
		}
		if err := ev.checkBudget(1); err != nil {
			return nil, err
		}
		return &sparsePoly{terms: map[string]*sparseTerm{
			exponentKey(exponents): term,
		}}, nil
	case KindZero:
		return newSparsePoly(), nil
	case KindOne:
		exponents := make([]int, len(ev.variables))
		if err := ev.checkBudget(1); err != nil {
			return nil, err
		}
		return &sparsePoly{terms: map[string]*sparseTerm{
			"": {exponents: exponents, coefficient: big.NewInt(1)},
		}}, nil
	case KindUnion:
		return ev.evalUnion(node)
	case KindJoin:
		return ev.evalJoin(node)
	default:
		return nil, ErrNilExpression
	}
}

func (ev *evaluator) evalUnion(node *Expr) (*sparsePoly, error) {
	result := newSparsePoly()
	for _, child := range node.args {
		childPoly := ev.memo[child]
		if childPoly == nil {
			childPoly = newSparsePoly()
		}
		for key, childTerm := range childPoly.terms {
			if existing, ok := result.terms[key]; ok {
				existing.coefficient.Add(existing.coefficient, childTerm.coefficient)
				if existing.coefficient.Sign() == 0 {
					delete(result.terms, key)
				}
				continue
			}
			coefficient := new(big.Int).Set(childTerm.coefficient)
			result.terms[key] = &sparseTerm{
				exponents:   childTerm.exponents,
				coefficient: coefficient,
			}
			if err := ev.checkBudget(len(result.terms)); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

func (ev *evaluator) evalJoin(node *Expr) (*sparsePoly, error) {
	result := newSparsePoly()
	for i, child := range node.args {
		childPoly := ev.memo[child]
		if childPoly == nil || len(childPoly.terms) == 0 {
			return newSparsePoly(), nil
		}
		if i == 0 {
			result = childPoly
			continue
		}
		var err error
		result, err = ev.multiply(result, childPoly)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func (ev *evaluator) multiply(a, b *sparsePoly) (*sparsePoly, error) {
	result := newSparsePoly()
	for _, aTerm := range a.terms {
		for _, bTerm := range b.terms {
			exponents, err := addExponents(aTerm.exponents, bTerm.exponents)
			if err != nil {
				return nil, err
			}
			key := exponentKey(exponents)
			if existing, ok := result.terms[key]; ok {
				product := new(big.Int).Mul(aTerm.coefficient, bTerm.coefficient)
				existing.coefficient.Add(existing.coefficient, product)
				continue
			}
			product := new(big.Int).Mul(aTerm.coefficient, bTerm.coefficient)
			result.terms[key] = &sparseTerm{
				exponents:   exponents,
				coefficient: product,
			}
			if err := ev.checkBudget(len(result.terms)); err != nil {
				return nil, err
			}
		}
	}
	return result, nil
}

func addExponents(a, b []int) ([]int, error) {
	exponents := make([]int, len(a))
	for i := range a {
		if a[i] > math.MaxInt-b[i] {
			return nil, ErrExponentOverflow
		}
		exponents[i] = a[i] + b[i]
	}
	return exponents, nil
}

func (ev *evaluator) render(sparse *sparsePoly) *Polynomial {
	if sparse == nil || len(sparse.terms) == 0 {
		return &Polynomial{}
	}
	result := &Polynomial{
		Variables: append([]string(nil), ev.variables...),
		Terms:     make([]Term, 0, len(sparse.terms)),
	}
	for _, sparseTerm := range sparse.terms {
		if sparseTerm.coefficient.Sign() == 0 {
			continue
		}
		term := Term{
			Exponents: append([]int(nil), sparseTerm.exponents...),
		}
		term.Coefficient.Set(sparseTerm.coefficient)
		result.Terms = append(result.Terms, term)
	}
	sortTerms(result.Terms)
	if len(result.Terms) == 0 {
		return &Polynomial{}
	}
	return result
}
