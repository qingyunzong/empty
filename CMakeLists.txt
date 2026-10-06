cmake_minimum_required(VERSION 3.20)
project(netsim LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug)
endif()

add_compile_options(-Wall -Wextra -Wpedantic)

add_library(netsim src/simulator.cpp src/reference.cpp)
target_include_directories(netsim PUBLIC src)

add_executable(netsim_cli src/main.cpp)
target_link_libraries(netsim_cli PRIVATE netsim)

enable_testing()
foreach(case basic multihop cancel reference)
    add_executable(test_${case} tests/test_${case}.cpp)
    target_include_directories(test_${case} PRIVATE tests)
    target_link_libraries(test_${case} PRIVATE netsim)
    add_test(NAME ${case} COMMAND test_${case})
endforeach()
