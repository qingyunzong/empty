# Runs ${EXE} on ${INPUT} and compares stdout byte-for-byte with ${EXPECTED}.
execute_process(
    COMMAND "${EXE}" "${INPUT}"
    OUTPUT_VARIABLE actual
    ERROR_VARIABLE err
    RESULT_VARIABLE rc
)
if(NOT rc EQUAL 0)
    message(FATAL_ERROR "${EXE} exited with ${rc}: ${err}")
endif()
file(READ "${EXPECTED}" expected)
if(NOT actual STREQUAL expected)
    message(FATAL_ERROR
        "output mismatch for ${INPUT}\n--- got ---\n${actual}\n--- want ---\n${expected}")
endif()
