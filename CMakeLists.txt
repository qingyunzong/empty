cmake_minimum_required(VERSION 3.16)
project(patrol CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(patrol_lib src/solver.cpp)
target_include_directories(patrol_lib PUBLIC src)
target_compile_options(patrol_lib PRIVATE -Wall -Wextra -Wpedantic)

add_executable(patrol src/main.cpp)
target_link_libraries(patrol PRIVATE patrol_lib)
target_compile_options(patrol PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()

add_executable(patrol_tests tests/test_solver.cpp)
target_link_libraries(patrol_tests PRIVATE patrol_lib)
target_compile_options(patrol_tests PRIVATE -Wall -Wextra -Wpedantic)
add_test(NAME solver_tests COMMAND patrol_tests)

add_test(NAME cli_sample_ok
         COMMAND patrol ${CMAKE_CURRENT_SOURCE_DIR}/tests/sample_ok.txt)
set_tests_properties(cli_sample_ok PROPERTIES
    PASS_REGULAR_EXPRESSION "cost 7")

add_test(NAME cli_sample_unreachable
         COMMAND patrol ${CMAKE_CURRENT_SOURCE_DIR}/tests/sample_unreachable.txt)
set_tests_properties(cli_sample_unreachable PROPERTIES
    PASS_REGULAR_EXPRESSION "status unreachable")

add_test(NAME cli_verify_flag
         COMMAND patrol --verify ${CMAKE_CURRENT_SOURCE_DIR}/tests/sample_ok.txt)
set_tests_properties(cli_verify_flag PROPERTIES
    PASS_REGULAR_EXPRESSION "verify ok")
