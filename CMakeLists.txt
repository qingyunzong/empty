cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dlks_formal INTERFACE)
target_include_directories(
  dlks_formal INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)

set(DLKS_WARNINGS)
if(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
  set(DLKS_WARNINGS -Wall -Wextra -Wpedantic -Wconversion -Wsign-conversion)
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(dlks_formal_tests tests/dlks_formal_tests.cpp)
  target_link_libraries(dlks_formal_tests PRIVATE dlks_formal)
  target_compile_options(dlks_formal_tests PRIVATE ${DLKS_WARNINGS})
  add_test(NAME dlks_formal_tests COMMAND dlks_formal_tests)

  add_executable(dlks_formal_exhaustive tests/exhaustive.cpp)
  target_link_libraries(dlks_formal_exhaustive PRIVATE dlks_formal)
  target_compile_options(dlks_formal_exhaustive PRIVATE ${DLKS_WARNINGS})
  add_test(NAME dlks_formal_exhaustive COMMAND dlks_formal_exhaustive)

  add_executable(dlks_formal_exhaustive_tree tests/exhaustive.cpp)
  target_compile_definitions(
    dlks_formal_exhaustive_tree PRIVATE DLKS_EXH_LBAS=1
                                       DLKS_EXH_SNAPSHOTS=4
                                       DLKS_EXH_BLOCKS=4)
  target_link_libraries(dlks_formal_exhaustive_tree PRIVATE dlks_formal)
  target_compile_options(dlks_formal_exhaustive_tree
                         PRIVATE ${DLKS_WARNINGS})
  add_test(NAME dlks_formal_exhaustive_tree
           COMMAND dlks_formal_exhaustive_tree)
endif()
