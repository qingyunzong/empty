# Drives one CLI test: runs ${EXE} on a log file (or standard input when
# LOG is "-") and checks the exit code and stdout against expectations.
#
# Required: EXE, LOG, MOD, WIN, EXPECT_EXIT, EXPECT_REGEX
# Optional: STDIN_FILE (used when LOG is "-")

if(NOT DEFINED EXE OR NOT DEFINED LOG OR NOT DEFINED EXPECT_EXIT)
  message(FATAL_ERROR "cli_test.cmake: missing required variables")
endif()

if(LOG STREQUAL "-")
  execute_process(
    COMMAND "${EXE}" --modulus "${MOD}" --window "${WIN}" -
    INPUT_FILE "${STDIN_FILE}"
    RESULT_VARIABLE rc
    OUTPUT_VARIABLE out
    ERROR_VARIABLE err)
else()
  execute_process(
    COMMAND "${EXE}" --modulus "${MOD}" --window "${WIN}" "${LOG}"
    RESULT_VARIABLE rc
    OUTPUT_VARIABLE out
    ERROR_VARIABLE err)
endif()

if(NOT "${rc}" STREQUAL "${EXPECT_EXIT}")
  message(FATAL_ERROR "exit code ${rc}, expected ${EXPECT_EXIT}\nstdout:\n${out}\nstderr:\n${err}")
endif()

if(DEFINED EXPECT_REGEX AND NOT "${out}" MATCHES "${EXPECT_REGEX}")
  message(FATAL_ERROR "stdout does not match '${EXPECT_REGEX}':\n${out}")
endif()
