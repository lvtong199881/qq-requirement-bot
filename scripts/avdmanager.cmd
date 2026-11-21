@echo off
rem avdmanager requires JDK 17+, while JAVA_HOME on this machine is 11 (used by Flutter/Gradle).
rem Switch to Android Studio's bundled JBR for this call only; do not touch global env.
rem Also make sure System32 is on PATH: avdmanager.bat shells out to findstr.
rem The emulator service uses this wrapper to delete AVDs (config.tools.android.avdmanager).
setlocal
set "PATH=%SystemRoot%\System32;%SystemRoot%;%PATH%"
set "AVDM=%LOCALAPPDATA%\Android\Sdk\cmdline-tools\latest\bin\avdmanager.bat"
if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
call "%AVDM%" %*
endlocal
