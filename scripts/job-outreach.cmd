@echo off
REM ---------------------------------------------------------------------------
REM Wrapper invoked by the "Personal Pitcher job outreach" scheduled task at
REM 08:00 (section 11 of docs\job-outreach-plan.md).
REM
REM Copied from refresh-profile.cmd, and the reasons in that file apply here
REM unchanged:
REM
REM   1. A scheduled task starts in C:\Windows\System32 with a minimal
REM      environment. `cd /d` below pins the working directory, which the job
REM      depends on: config.ts resolves data/ from process.cwd().
REM
REM   2. Task Scheduler records an exit code and nothing else, and this run can
REM      take its whole hour. The transcript goes to logs\job-outreach.log.
REM
REM npm is called by absolute path because PATH is not guaranteed to carry the
REM Node install under the task's environment, and a PATH miss here surfaces as
REM a bare exit code 1 with no clue as to the cause.
REM
REM The 09:00 deadline is wall clock, not a duration, so a task that catches up
REM at 08:40 because the laptop was asleep still finishes before the working
REM day. Nothing here needs to know that; OUTREACH_RUN_DEADLINE does.
REM ---------------------------------------------------------------------------

cd /d "%~dp0.."

set "NPM=C:\Program Files\nodejs\npm.cmd"
if not exist "%NPM%" set "NPM=npm"

if not exist "logs" mkdir "logs"

echo. >> "logs\job-outreach.log"
echo ===== %DATE% %TIME% : starting job outreach ===== >> "logs\job-outreach.log"

call "%NPM%" run outreach >> "logs\job-outreach.log" 2>&1
set "RESULT=%ERRORLEVEL%"

echo ===== %DATE% %TIME% : finished, exit code %RESULT% ===== >> "logs\job-outreach.log"

REM Propagated so Task Scheduler's "Last Run Result" column is meaningful. 0 for
REM "ran, maybe nothing to show" -- including a sleeping Mac and a deadline hit
REM -- and 1 only when a source genuinely failed.
exit /b %RESULT%
