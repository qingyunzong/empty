cmake_minimum_required(VERSION 3.16)
project(dataeng LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
add_library(dataeng dataeng.cpp)
add_library(dataeng::dataeng ALIAS dataeng)
target_include_directories(dataeng PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
add_executable(warc-assemble tools/warc_assemble.cpp)
target_link_libraries(warc-assemble PRIVATE dataeng)

if(MSVC)
    target_compile_options(dataeng PRIVATE /W4)
    target_compile_options(warc-assemble PRIVATE /W4)
else()
    target_compile_options(dataeng PRIVATE -Wall -Wextra -Wpedantic)
    target_compile_options(warc-assemble PRIVATE -Wall -Wextra -Wpedantic)
endif()

include(CTest)
if(BUILD_TESTING)
    add_subdirectory(tests)
endif()

include(GNUInstallDirs)
install(TARGETS dataeng warc-assemble
        ARCHIVE DESTINATION "${CMAKE_INSTALL_LIBDIR}"
        LIBRARY DESTINATION "${CMAKE_INSTALL_LIBDIR}"
        RUNTIME DESTINATION "${CMAKE_INSTALL_BINDIR}")
install(FILES dataeng.hpp DESTINATION "${CMAKE_INSTALL_INCLUDEDIR}")
