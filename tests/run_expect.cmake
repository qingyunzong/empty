# Runs a command and asserts on its exit code and combined output.
# Required -D args: EXE, EXPECT_EXIT, EXPECT_REGEX; optional: ARGS (list).
if(NOT DEFINED EXE OR NOT DEFINED EXPECT_EXIT OR NOT DEFINED EXPECT_REGEX)
  message(FATAL_ERROR "run_expect.cmake: missing EXE/EXPECT_EXIT/EXPECT_REGEX")
endif()

execute_process(
  COMMAND ${EXE} ${ARGS}
  RESULT_VARIABLE actual_exit
  OUTPUT_VARIABLE output
  ERROR_VARIABLE errors
)

set(combined "${output}${errors}")

if(NOT actual_exit STREQUAL EXPECT_EXIT)
  message(FATAL_ERROR
    "exit code ${actual_exit}, expected ${EXPECT_EXIT}\noutput:\n${combined}")
endif()

if(NOT combined MATCHES "${EXPECT_REGEX}")
  message(FATAL_ERROR
    "output does not match /${EXPECT_REGEX}/\noutput:\n${combined}")
endif()

message(STATUS "ok: exit ${actual_exit}, output matches /${EXPECT_REGEX}/")
