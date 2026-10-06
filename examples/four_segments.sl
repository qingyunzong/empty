# Four-way join: exactly 4 singleton segments, no merging needed.
input x
if x < 64 goto a
if x < 128 goto b
if x < 192 goto c
goto d
a: x = 10
goto j
b: x = 80
goto j
c: x = 150
goto j
d: x = 220
j: halt
