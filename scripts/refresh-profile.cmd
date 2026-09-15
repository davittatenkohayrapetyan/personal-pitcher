@echo off
REM ---------------------------------------------------------------------------
REM Wrapper invoked by the "Personal Pitcher profile refresh" scheduled task.
REM
REM The task calls this rather than `npm run refresh:profile` directly, for two
REM reasons:
REM
REM   1. A scheduled task starts in C:\Windows\System32 with a minimal
REM      environment. `cd /d` below pins the working directory, which the job
REM      depends on: config.ts resolves data/ from process.cwd().
REM
REM   2. Task Scheduler records an exit code and nothing else. Without a
REM      transcript, a run that failed at 23:00 leaves no way to find out why.
REM      Everything goes to logs\scheduled-refresh.log.
REM
REM npm is called by absolute path because PATH is not guaranteed to carry the
REM Node install under the task's environment, and a PATH miss here surfaces as
REM a bare exit code 1 with no clue as to the cause.
REM ---------------------------------------------------------------------------

cd /d "%~dp0.."

set "NPM=C:\Program Files\nodejs\npm.cmd"
if not exist "%NPM%" set "NPM=npm"

if not exist "logs" mkdir "logs"

echo. >> "logs\scheduled-refresh.log"
echo ===== %DATE% %TIME% : starting scheduled refresh ===== >> "logs\scheduled-refresh.log"

call "%NPM%" run refresh:profile >> "logs\scheduled-refresh.log" 2>&1
set "RESULT=%ERRORLEVEL%"

echo ===== %DATE% %TIME% : finished, exit code %RESULT% ===== >> "logs\scheduled-refresh.log"

REM Propagated so Task Scheduler's "Last Run Result" column is meaningful. The
REM job exits 0 for a configuration skip (Mac asleep, no GitHub token) and 1
REM only when a source genuinely failed -- see scripts/refresh-profile.ts.
exit /b %RESULT%
