cmake_minimum_required(VERSION 3.20)
project(pagefile LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

add_library(pagefile INTERFACE)
target_include_directories(pagefile INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

option(PAGEFILE_SANITIZERS "Build tests with AddressSanitizer + UBSan" OFF)

find_package(Threads REQUIRED)

enable_testing()

set(PAGEFILE_TESTS basic_test interleaving_test threading_test)

foreach(test_name IN LISTS PAGEFILE_TESTS)
  add_executable(${test_name} tests/${test_name}.cpp)
  target_link_libraries(${test_name} PRIVATE pagefile Threads::Threads)
  target_include_directories(${test_name} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/tests)
  if(MSVC)
    target_compile_options(${test_name} PRIVATE /W4 /WX)
  else()
    target_compile_options(${test_name} PRIVATE -Wall -Wextra -Wpedantic -Werror)
  endif()
  if(PAGEFILE_SANITIZERS AND NOT MSVC)
    target_compile_options(${test_name} PRIVATE -fsanitize=address,undefined)
    target_link_options(${test_name} PRIVATE -fsanitize=address,undefined)
  endif()
  add_test(NAME ${test_name} COMMAND ${test_name})
endforeach()

# LeakSanitizer needs ptrace, which is unavailable in some sandboxes; the
# CountingMapper already asserts every mapping is released exactly once.
if(PAGEFILE_SANITIZERS AND NOT MSVC)
  set_tests_properties(${PAGEFILE_TESTS}
    PROPERTIES ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0")
endif()
