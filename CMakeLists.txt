cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dlks_formal INTERFACE)
target_include_directories(dlks_formal INTERFACE
  ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_compile_features(dlks_formal INTERFACE cxx_std_20)

option(DLKS_BUILD_TESTS "Build the exhaustive and concurrency tests" ON)
option(DLKS_SANITIZE "Enable AddressSanitizer and UndefinedBehaviorSanitizer" OFF)

if(DLKS_BUILD_TESTS)
  enable_testing()
  find_package(Threads REQUIRED)

  add_executable(dlks_tests
    tests/main.cpp
    tests/exhaustive_test.cpp
    tests/scenario_test.cpp
    tests/concurrency_test.cpp)
  target_link_libraries(dlks_tests PRIVATE dlks_formal Threads::Threads)

  if(MSVC)
    target_compile_options(dlks_tests PRIVATE /W4)
  else()
    target_compile_options(dlks_tests PRIVATE -Wall -Wextra -Wpedantic)
  endif()

  if(DLKS_SANITIZE AND NOT MSVC)
    target_compile_options(dlks_tests PRIVATE
      -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(dlks_tests PRIVATE -fsanitize=address,undefined)
  endif()

  add_test(NAME dlks_tests COMMAND dlks_tests)
endif()
