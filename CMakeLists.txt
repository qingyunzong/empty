cmake_minimum_required(VERSION 3.16)
project(dataeng LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(dataeng dataeng.cpp)
target_include_directories(dataeng PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_compile_features(dataeng PUBLIC cxx_std_20)

include(CTest)
if(BUILD_TESTING)
  add_executable(dataeng_tests tests/test_page_index.cpp)
  target_link_libraries(dataeng_tests PRIVATE dataeng)
  add_test(NAME dataeng_tests COMMAND dataeng_tests)
endif()

include(GNUInstallDirs)
install(TARGETS dataeng
        ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}"
        LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}"
        RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
install(FILES dataeng.hpp DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}")
