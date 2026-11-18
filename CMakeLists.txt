cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)

add_library(dlks_formal INTERFACE)
add_library(dlks_formal::dlks_formal ALIAS dlks_formal)
target_compile_features(dlks_formal INTERFACE cxx_std_20)
target_include_directories(
  dlks_formal
  INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)

include(CTest)
if(BUILD_TESTING)
  find_package(Threads REQUIRED)

  add_executable(dlks_formal_tests tests/page_cache_test.cpp)
  target_link_libraries(dlks_formal_tests PRIVATE dlks_formal Threads::Threads)
  if(MSVC)
    target_compile_options(dlks_formal_tests PRIVATE /W4 /permissive-)
  else()
    target_compile_options(
      dlks_formal_tests
      PRIVATE -Wall -Wextra -Wpedantic -Wshadow -Wconversion)
  endif()

  add_test(NAME dlks_formal.page_cache COMMAND dlks_formal_tests)
endif()
