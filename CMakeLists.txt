cmake_minimum_required(VERSION 3.16)
project(score_cli LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(score src/parser.cpp)
target_include_directories(score PUBLIC src)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(score PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(score-cli src/main.cpp)
target_link_libraries(score-cli PRIVATE score)

enable_testing()

add_executable(score_tests tests/test_score.cpp)
target_link_libraries(score_tests PRIVATE score)
add_test(NAME unit COMMAND score_tests)

foreach(case basic tuplet)
    add_test(
        NAME cli_${case}
        COMMAND ${CMAKE_COMMAND}
            -DEXE=$<TARGET_FILE:score-cli>
            -DINPUT=${CMAKE_CURRENT_SOURCE_DIR}/examples/${case}.score
            -DEXPECTED=${CMAKE_CURRENT_SOURCE_DIR}/examples/${case}.expected
            -P ${CMAKE_CURRENT_SOURCE_DIR}/cmake/run_and_compare.cmake
    )
endforeach()
