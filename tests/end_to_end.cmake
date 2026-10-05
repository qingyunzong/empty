# End-to-end CLI test: idxgen produces extreme/truncated files, idxcheck
# must classify each with the expected exit code and message.
# Required -D args: IDXCHECK, IDXGEN, WORK

if(NOT DEFINED IDXCHECK OR NOT DEFINED IDXGEN OR NOT DEFINED WORK)
  message(FATAL_ERROR "end_to_end: missing -DIDXCHECK/-DIDXGEN/-DWORK")
endif()

file(REMOVE_RECURSE "${WORK}")
file(MAKE_DIRECTORY "${WORK}")

# run_case(<name> <expected-exit-code> <expected-output-regex>)
function(run_case name expect_exit expect_regex)
  set(file "${WORK}/${name}.idx")
  execute_process(
    COMMAND "${IDXGEN}" "${name}" "${file}"
    RESULT_VARIABLE rc OUTPUT_VARIABLE out ERROR_VARIABLE err)
  if(NOT rc EQUAL 0)
    message(FATAL_ERROR "idxgen ${name} failed (exit ${rc}): ${out}${err}")
  endif()
  execute_process(
    COMMAND "${IDXCHECK}" "${file}"
    RESULT_VARIABLE rc OUTPUT_VARIABLE out ERROR_VARIABLE err)
  if(NOT rc EQUAL ${expect_exit})
    message(FATAL_ERROR
      "idxcheck ${name}: exit ${rc}, expected ${expect_exit}: ${out}${err}")
  endif()
  if(NOT "${out}" MATCHES "${expect_regex}")
    message(FATAL_ERROR
      "idxcheck ${name}: output '${out}' does not match '${expect_regex}'")
  endif()
  string(STRIP "${out}" out)
  message(STATUS "case ${name}: exit ${rc}, ${out}")
endfunction()

run_case(valid               0 "OK: 3 segment")
run_case(empty               0 "OK: 0 segment")
run_case(shared              0 "OK: 3 segment")
run_case(zero-len-inside     0 "OK: 2 segment")
run_case(overlap             1 "INVALID: segments partially overlap")
run_case(nested              1 "INVALID: segments partially overlap")
run_case(overflow-end        1 "INVALID: offset . length overflows 64 bits")
run_case(max-end-beyond-file 1 "INVALID: segment extends past end of file")
run_case(beyond-file         1 "INVALID: segment extends past end of file")
run_case(huge-count          1 "INVALID: record table size overflows 64 bits")
run_case(truncated-table     1 "INVALID: record table truncated")
run_case(truncated-header    1 "INVALID: truncated header")
run_case(bad-magic           1 "INVALID: bad magic")

# Usage / IO errors exit with code 2.
execute_process(COMMAND "${IDXCHECK}" RESULT_VARIABLE rc)
if(NOT rc EQUAL 2)
  message(FATAL_ERROR "idxcheck without args: exit ${rc}, expected 2")
endif()
execute_process(COMMAND "${IDXCHECK}" "${WORK}/does-not-exist.idx"
  RESULT_VARIABLE rc)
if(NOT rc EQUAL 2)
  message(FATAL_ERROR "idxcheck on missing file: exit ${rc}, expected 2")
endif()

# --list must report every segment view as in-bounds.
execute_process(
  COMMAND "${IDXCHECK}" --list "${WORK}/valid.idx"
  RESULT_VARIABLE rc OUTPUT_VARIABLE out)
if(NOT rc EQUAL 0)
  message(FATAL_ERROR "idxcheck --list valid: exit ${rc}")
endif()
if("${out}" MATCHES "OUT-OF-BOUNDS")
  message(FATAL_ERROR "idxcheck --list valid: out-of-bounds view reported")
endif()
string(REGEX MATCHALL "in-bounds" hits "${out}")
list(LENGTH hits nhits)
if(NOT nhits EQUAL 3)
  message(FATAL_ERROR "idxcheck --list valid: expected 3 in-bounds views, got ${nhits}")
endif()

message(STATUS "end_to_end: all CLI cases passed")
