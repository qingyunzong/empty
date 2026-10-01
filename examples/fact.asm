.consts 1 5
.locals 1
main:
  CONST 1      # push 5
  CALL fact
  HALT
fact:
  STORE 0      # n = arg
  LOAD 0
  JZ base
  LOAD 0
  LOAD 0
  CONST 0      # push 1
  SUB
  CALL fact
  MUL
  RET
base:
  CONST 0
  RET
