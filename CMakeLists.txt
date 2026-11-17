cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dlks_formal INTERFACE)
target_include_directories(dlks_formal INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(dlks_formal INTERFACE cxx_std_20)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  set(DLKS_TOP_LEVEL_DEFAULT ON)
else()
  set(DLKS_TOP_LEVEL_DEFAULT OFF)
endif()

option(DLKS_BUILD_TESTS "Build the test suite" ${DLKS_TOP_LEVEL_DEFAULT})
option(DLKS_BUILD_EXAMPLES "Build the demo executable" ${DLKS_TOP_LEVEL_DEFAULT})
option(DLKS_SANITIZE "Build tests with AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

if(DLKS_BUILD_TESTS)
  enable_testing()
  add_executable(dlks_tests
    tests/test_main.cpp
    tests/test_core.cpp
    tests/test_logic.cpp
    tests/test_differential.cpp)
  target_link_libraries(dlks_tests PRIVATE dlks_formal)
  target_compile_options(dlks_tests PRIVATE -Wall -Wextra -Wshadow)
  if(DLKS_SANITIZE)
    target_compile_options(dlks_tests PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(dlks_tests PRIVATE -fsanitize=address,undefined)
  endif()

  add_test(NAME dlks_tests COMMAND dlks_tests)
  add_test(NAME dlks_tests_quick COMMAND dlks_tests --seeds=40)
  if(DLKS_SANITIZE)
    set_tests_properties(dlks_tests dlks_tests_quick PROPERTIES
      ENVIRONMENT "ASAN_OPTIONS=detect_leaks=0")
  endif()
endif()

if(DLKS_BUILD_EXAMPLES)
  add_executable(dlks_demo examples/demo.cpp)
  target_link_libraries(dlks_demo PRIVATE dlks_formal)
  target_compile_options(dlks_demo PRIVATE -Wall -Wextra)
endif()
