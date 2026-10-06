cmake_minimum_required(VERSION 3.20)
project(kway_merge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(kway_merge INTERFACE)
target_include_directories(kway_merge INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

option(KWAY_ENABLE_SANITIZERS "Build tests with ASan/UBSan" OFF)

enable_testing()

set(KWAY_TESTS
    test_merge
    test_pause
    test_error
    test_cancel
    test_lookahead
)

foreach(test_name IN LISTS KWAY_TESTS)
    add_executable(${test_name} tests/${test_name}.cpp)
    target_link_libraries(${test_name} PRIVATE kway_merge)
    target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
    if(MSVC)
        target_compile_options(${test_name} PRIVATE /W4)
    else()
        target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
    if(KWAY_ENABLE_SANITIZERS AND NOT MSVC)
        target_compile_options(${test_name} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
        target_link_options(${test_name} PRIVATE -fsanitize=address,undefined)
    endif()
    add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()
