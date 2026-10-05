cmake_minimum_required(VERSION 3.20)
project(cosched LANGUAGES CXX)

option(COSCHED_SANITIZERS "Build tests with AddressSanitizer + UBSan" OFF)

add_library(cosched INTERFACE)
target_include_directories(cosched INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(cosched INTERFACE cxx_std_20)

if(MSVC)
    target_compile_options(cosched INTERFACE /W4)
else()
    target_compile_options(cosched INTERFACE -Wall -Wextra)
endif()

if(COSCHED_SANITIZERS AND NOT MSVC)
    add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
    add_link_options(-fsanitize=address,undefined)
endif()

enable_testing()

set(COSCHED_TESTS
    test_completion
    test_destroy_suspended
    test_race
    test_shutdown
    test_timer)

foreach(t IN LISTS COSCHED_TESTS)
    add_executable(${t} tests/${t}.cpp)
    target_link_libraries(${t} PRIVATE cosched)
    add_test(NAME ${t} COMMAND ${t})
endforeach()
