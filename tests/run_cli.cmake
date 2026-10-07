# CLI test driver: runs seqcheck, verifies exit code and output regex.
# Expects: SEQCHECK, EXPECT_RC, EXPECT_REGEX (optional), CLI_ARGS (list).
execute_process(
  COMMAND ${SEQCHECK} ${CLI_ARGS}
  RESULT_VARIABLE rc
  OUTPUT_VARIABLE out
  ERROR_VARIABLE err)
set(all "${out}${err}")
if(NOT rc EQUAL EXPECT_RC)
  message(FATAL_ERROR "expected exit code ${EXPECT_RC}, got ${rc}\noutput:\n${all}")
endif()
if(DEFINED EXPECT_REGEX AND NOT "${EXPECT_REGEX}" STREQUAL "")
  if(NOT all MATCHES "${EXPECT_REGEX}")
    message(FATAL_ERROR "output does not match '${EXPECT_REGEX}'\noutput:\n${all}")
  endif()
endif()
message(STATUS "ok: exit ${rc}, output matched")
