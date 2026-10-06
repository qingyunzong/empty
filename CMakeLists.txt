cmake_minimum_required(VERSION 3.20)
project(wrapfix CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(analyzer_core
    src/interval_set.cpp
    src/program.cpp
    src/analysis.cpp
    src/verify.cpp
)
target_include_directories(analyzer_core PUBLIC src)
target_compile_options(analyzer_core PRIVATE -Wall -Wextra)

add_executable(analyzer src/main.cpp)
target_link_libraries(analyzer PRIVATE analyzer_core)
target_compile_options(analyzer PRIVATE -Wall -Wextra)

enable_testing()

add_executable(analyzer_tests tests/test_main.cpp)
target_link_libraries(analyzer_tests PRIVATE analyzer_core)
target_compile_options(analyzer_tests PRIVATE -Wall -Wextra)
add_test(NAME unit COMMAND analyzer_tests)

foreach(example count_up wrap_orbit branch_merge count_down)
    add_test(NAME cli_${example}
             COMMAND analyzer --verify ${CMAKE_CURRENT_SOURCE_DIR}/examples/${example}.an)
    set_tests_properties(cli_${example} PROPERTIES
        PASS_REGULAR_EXPRESSION "VERIFIED: abstract result covers all concrete states")
endforeach()

add_test(NAME cli_bad_program
         COMMAND analyzer ${CMAKE_CURRENT_SOURCE_DIR}/examples/does_not_exist.an)
set_tests_properties(cli_bad_program PROPERTIES WILL_FAIL TRUE)
