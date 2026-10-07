cmake_minimum_required(VERSION 3.20)
project(motion LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(motion
    src/bigint.cpp
    src/rational.cpp
    src/simulation.cpp
)
target_include_directories(motion PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(motion PRIVATE -Wall -Wextra -Wpedantic)
endif()

add_executable(motion_cli examples/motion_cli.cpp)
target_link_libraries(motion_cli PRIVATE motion)

enable_testing()
foreach(test_name test_bigint_rational test_simulation test_reference)
    add_executable(${test_name} tests/${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE motion)
    if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()
