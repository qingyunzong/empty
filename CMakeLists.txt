cmake_minimum_required(VERSION 3.20)
project(numimport CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(numimport_core
    src/numparse.cpp
    src/column.cpp
    src/csv.cpp)
target_include_directories(numimport_core PUBLIC src)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(numimport_core PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(numimport src/main.cpp)
target_link_libraries(numimport PRIVATE numimport_core)

enable_testing()

add_executable(numimport_tests tests/tests.cpp)
target_link_libraries(numimport_tests PRIVATE numimport_core)

foreach(suite parser exhaustive column csv)
    add_test(NAME ${suite} COMMAND numimport_tests ${suite})
endforeach()

add_test(NAME cli_end_to_end
    COMMAND ${CMAKE_COMMAND}
        -DBIN=$<TARGET_FILE:numimport>
        -DDATA=${CMAKE_CURRENT_SOURCE_DIR}/tests/data
        -P ${CMAKE_CURRENT_SOURCE_DIR}/tests/cli_test.cmake)
