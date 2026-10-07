cmake_minimum_required(VERSION 3.16)
project(deadlock_diag CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Debug)
endif()

add_compile_options(-Wall -Wextra -Wpedantic)

add_library(dlmodel src/model.cpp)
target_include_directories(dlmodel PUBLIC src)

add_executable(deadlock_diag src/main.cpp)
target_link_libraries(deadlock_diag PRIVATE dlmodel)

enable_testing()

add_executable(test_model tests/test_model.cpp)
target_link_libraries(test_model PRIVATE dlmodel)
add_test(NAME model COMMAND test_model)

set(LOGS ${CMAKE_CURRENT_SOURCE_DIR}/tests/logs)
set(RUN_EXPECT ${CMAKE_CURRENT_SOURCE_DIR}/tests/run_expect.cmake)

# Adds a CLI test asserting the exit code and a regex over stdout+stderr.
function(add_cli_test name log expect_exit expect_regex)
  add_test(NAME ${name}
    COMMAND ${CMAKE_COMMAND}
      -DEXE=$<TARGET_FILE:deadlock_diag>
      -DARGS=${log}
      -DEXPECT_EXIT=${expect_exit}
      "-DEXPECT_REGEX=${expect_regex}"
      -P ${RUN_EXPECT})
endfunction()

add_cli_test(cli_deadlock ${LOGS}/deadlock2.log 1
  "Deadlock detected at event #4")
add_cli_test(cli_clean ${LOGS}/clean.log 0
  "No deadlock detected")
add_cli_test(cli_shared_ok ${LOGS}/shared_ok.log 0
  "No deadlock detected")
add_cli_test(cli_incomplete ${LOGS}/incomplete.log 0
  "No deadlock detected")
add_cli_test(cli_upgrade ${LOGS}/upgrade.log 1
  "Shortest wait-for cycle .1 thread.")
add_cli_test(cli_parse_error ${LOGS}/bad.log 2
  "parse error at line 2")

add_test(NAME cli_all_flag
  COMMAND ${CMAKE_COMMAND}
    -DEXE=$<TARGET_FILE:deadlock_diag>
    "-DARGS=--all;${LOGS}/deadlock2.log"
    -DEXPECT_EXIT=1
    "-DEXPECT_REGEX=Deadlock present at 1 of 4 moments"
    -P ${RUN_EXPECT})
