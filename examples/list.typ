# Linked-list interfaces exercising recursion and variance.

type IntList = interface {
	Head: int
	Tail: IntList
	Map(f: func(int) int): IntList
}

# A read-only view: IntList has every member it needs.
type IntListRead = interface {
	Head: int
	Tail: IntListRead
}

# Covariant element type and a contravariant-safe Map parameter.
type AnyValList = interface {
	Head: any
	Tail: AnyValList
	Map(f: func(any) int): AnyValList
}

# Map's parameter func(any) any is NOT a subtype of func(int) int
# (its result any is not a subtype of int), so this check fails.
type AnyList = interface {
	Head: any
	Tail: AnyList
	Map(f: func(any) any): AnyList
}

check IntList <: IntListRead
check IntList <: AnyValList
check IntList <: AnyList
