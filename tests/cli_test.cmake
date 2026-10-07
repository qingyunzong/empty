# End-to-end CLI test, run via ctest. Expects -DBIN=<numimport> -DDATA=<dir>.

execute_process(
    COMMAND "${BIN}" --header "${DATA}/sample.csv"
    OUTPUT_VARIABLE out ERROR_VARIABLE err RESULT_VARIABLE rc)
if(NOT rc EQUAL 0)
    message(FATAL_ERROR "numimport failed on sample.csv (rc=${rc}): ${err}")
endif()
file(READ "${DATA}/sample.expected.csv" expected)
if(NOT out STREQUAL expected)
    message(FATAL_ERROR "sample.csv output mismatch.\nExpected:\n${expected}\nGot:\n${out}")
endif()

execute_process(
    COMMAND "${BIN}" --header "${DATA}/ambiguous.csv"
    OUTPUT_VARIABLE out ERROR_VARIABLE err RESULT_VARIABLE rc)
if(rc EQUAL 0)
    message(FATAL_ERROR "ambiguous.csv: expected non-zero exit code")
endif()
if(NOT err MATCHES "ambiguous")
    message(FATAL_ERROR "ambiguous.csv: expected 'ambiguous' diagnostic, got: ${err}")
endif()

execute_process(
    COMMAND "${BIN}" --header "${DATA}/inconsistent.csv"
    OUTPUT_VARIABLE out ERROR_VARIABLE err RESULT_VARIABLE rc)
if(rc EQUAL 0)
    message(FATAL_ERROR "inconsistent.csv: expected non-zero exit code")
endif()
if(NOT err MATCHES "no consistent decimal separator")
    message(FATAL_ERROR "inconsistent.csv: unexpected diagnostic: ${err}")
endif()

message(STATUS "CLI end-to-end tests passed")
