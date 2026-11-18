cmake_minimum_required(VERSION 3.20)
project(dlks_formal LANGUAGES CXX)

add_library(dlks_formal INTERFACE)
add_library(dlks_formal::dlks_formal ALIAS dlks_formal)

target_compile_features(dlks_formal INTERFACE cxx_std_20)
target_include_directories(
  dlks_formal
  INTERFACE
    $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
    $<INSTALL_INTERFACE:include>)

if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  option(DLKS_FORMAL_BUILD_TESTS "Build dlks_formal tests" ON)
  if(DLKS_FORMAL_BUILD_TESTS)
    enable_testing()
    add_subdirectory(tests)
  endif()
endif()
