cmake_minimum_required(VERSION 3.20)
project(blocking_queue LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

add_library(blocking_queue INTERFACE)
target_include_directories(blocking_queue INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(blocking_queue INTERFACE cxx_std_20)

find_package(Threads REQUIRED)

enable_testing()

set(TESTS
    exception_safety_test
    close_test
    linearizability_test
)

foreach(test_name IN LISTS TESTS)
    add_executable(${test_name} tests/${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE blocking_queue Threads::Threads)
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()
