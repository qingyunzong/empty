cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

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
  add_executable(dlks_graph_tests tests/test_wait_for_graph.cpp)
  target_link_libraries(dlks_graph_tests PRIVATE dlks_formal)
  target_include_directories(dlks_graph_tests PRIVATE tests)

  add_executable(dlks_manager_tests tests/test_lock_manager.cpp)
  target_link_libraries(dlks_manager_tests PRIVATE dlks_formal)
  target_include_directories(dlks_manager_tests PRIVATE tests)

  add_executable(dlks_exhaustive_tests tests/test_exhaustive.cpp)
  target_link_libraries(dlks_exhaustive_tests PRIVATE dlks_formal)
  target_include_directories(dlks_exhaustive_tests PRIVATE tests)

  if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
    foreach(target dlks_graph_tests dlks_manager_tests dlks_exhaustive_tests)
      target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic -O2)
    endforeach()
  endif()

  add_test(NAME dlks_graph_tests COMMAND dlks_graph_tests)
  add_test(NAME dlks_manager_tests COMMAND dlks_manager_tests)
  add_test(NAME dlks_exhaustive_tests COMMAND dlks_exhaustive_tests)
  set_tests_properties(
    dlks_graph_tests dlks_manager_tests dlks_exhaustive_tests
    PROPERTIES TIMEOUT 300)
endif()
