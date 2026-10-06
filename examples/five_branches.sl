# Five-way join: 5 singletons exceed the 4-segment cap, so the closest
# pair (70 and 100) is merged into [70,100]; still an over-approximation.
input x
if x < 32 goto a
if x < 64 goto b
if x < 96 goto c
if x < 128 goto d
goto e
a: x = 1
goto j
b: x = 70
goto j
c: x = 100
goto j
d: x = 200
goto j
e: x = 250
j: halt
