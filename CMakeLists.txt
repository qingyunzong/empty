cmake_minimum_required(VERSION 3.20)
project(rbatch LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(rbatch INTERFACE)
target_include_directories(rbatch INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
if(MSVC)
    target_compile_options(rbatch INTERFACE /W4 /WX)
else()
    target_compile_options(rbatch INTERFACE -Wall -Wextra -Wpedantic -Werror)
endif()

enable_testing()

add_executable(rbatch_tests tests/test_batch.cpp)
target_link_libraries(rbatch_tests PRIVATE rbatch)

foreach(t IN ITEMS
        type_traits
        success_release_order
        failure_at_k
        move_chain
        throwing_release
        release_once)
    add_test(NAME ${t} COMMAND rbatch_tests ${t})
endforeach()
