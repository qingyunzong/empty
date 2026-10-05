cmake_minimum_required(VERSION 3.20)
project(graphser CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(graphser INTERFACE)
target_include_directories(graphser INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(graphser INTERFACE cxx_std_20)

option(GRAPHSER_SANITIZERS "Build tests with ASan/UBSan/LeakSanitizer" ON)

enable_testing()

foreach(t IN ITEMS test_stable_ids test_roundtrip test_failure)
  add_executable(${t} tests/${t}.cpp)
  target_link_libraries(${t} PRIVATE graphser)
  target_include_directories(${t} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  target_compile_options(${t} PRIVATE -Wall -Wextra -Wpedantic)
  if(GRAPHSER_SANITIZERS AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    target_compile_options(${t} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(${t} PRIVATE -fsanitize=address,undefined)
  endif()
  add_test(NAME ${t} COMMAND ${t})
  # LeakSanitizer cannot run under ptrace-restricted sandboxes; leak
  # detection is covered by explicit allocation/instance counting in the
  # tests. ASan/UBSan remain active.
  set_tests_properties(${t} PROPERTIES
    ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0")
endforeach()
