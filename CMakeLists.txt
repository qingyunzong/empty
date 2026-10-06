cmake_minimum_required(VERSION 3.20)
project(statlib LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(statlib
    src/bigint.cpp
    src/rational.cpp
    src/stats_tree.cpp
)
target_include_directories(statlib PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(statlib PRIVATE -Wall -Wextra -Wpedantic)
endif()

enable_testing()
foreach(name bigint rational stats)
    add_executable(test_${name} tests/test_${name}.cpp)
    target_include_directories(test_${name} PRIVATE tests)
    target_link_libraries(test_${name} PRIVATE statlib)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(test_${name} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME ${name} COMMAND test_${name})
endforeach()
