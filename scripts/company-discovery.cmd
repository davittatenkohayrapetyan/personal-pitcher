@echo off
REM ---------------------------------------------------------------------------
REM Wrapper invoked by the "Personal Pitcher company discovery" scheduled task
REM at 07:00 (section 9, section 11 of docs\job-outreach-plan.md).
REM
REM Copied from refresh-profile.cmd, and the reasons in that file apply here
REM unchanged:
REM
REM   1. A scheduled task starts in C:\Windows\System32 with a minimal
REM      environment. `cd /d` below pins the working directory, which the job
REM      depends on: config.ts resolves data/ from process.cwd().
REM
REM   2. Task Scheduler records an exit code and nothing else. Without a
REM      transcript, a run that found nothing at 07:00 is indistinguishable from
REM      one that never reached the network. Everything goes to
REM      logs\company-discovery.log.
REM
REM npm is called by absolute path because PATH is not guaranteed to carry the
REM Node install under the task's environment, and a PATH miss here surfaces as
REM a bare exit code 1 with no clue as to the cause.
REM ---------------------------------------------------------------------------

cd /d "%~dp0.."

set "NPM=C:\Program Files\nodejs\npm.cmd"
if not exist "%NPM%" set "NPM=npm"

if not exist "logs" mkdir "logs"

echo. >> "logs\company-discovery.log"
echo ===== %DATE% %TIME% : starting company discovery ===== >> "logs\company-discovery.log"

call "%NPM%" run outreach:companies >> "logs\company-discovery.log" 2>&1
set "RESULT=%ERRORLEVEL%"

echo ===== %DATE% %TIME% : finished, exit code %RESULT% ===== >> "logs\company-discovery.log"

REM Propagated so Task Scheduler's "Last Run Result" column is meaningful. A
REM morning that verifies nothing exits 0 -- section 9 calls that the normal
REM outcome, and a history full of red because most days are quiet is a history
REM nobody reads. 1 means a feed genuinely failed.
exit /b %RESULT%
