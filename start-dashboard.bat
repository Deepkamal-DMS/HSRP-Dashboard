@echo off
setlocal

REM =====================================================================
REM  Starts the HSRP database, the API and the dashboard.
REM  The page MUST be served over http - opening index.html from
REM  disk fails, because a module script cannot load from file://.
REM
REM  Runs alongside the Vehicle Analytics dashboard without clashing:
REM      Vehicle   API :3003   page :4173
REM      HSRP      API :3004   page :4174
REM
REM  First time here? Run db\setup-db.bat instead - it creates the
REM  containers, applies the schema and loads the CSVs.
REM =====================================================================

set "API_PORT=3004"
set "PAGE_PORT=4174"

docker container inspect hsrp-db >nul 2>&1
if errorlevel 1 (
    echo The HSRP database has not been set up yet.
    echo Run this first:  db\setup-db.bat
    exit /b 1
)

echo Starting database and API containers...
docker start hsrp-db hsrp-api >nul 2>&1

echo Waiting for the API...
:wait
curl -s -o nul http://localhost:%API_PORT%/ || (ping -n 2 127.0.0.1 >nul & goto wait)

if not exist "%~dp0index.html" (
    echo.
    echo [WARN] No index.html here yet - the dashboard UI has not been built.
    echo        The database and API are up; you can query them directly:
    echo          curl "http://localhost:%API_PORT%/hsrp_load_summary"
    echo.
)

echo.
echo   Dashboard: http://localhost:%PAGE_PORT%
echo   API:       http://localhost:%API_PORT%
echo.
echo Press Ctrl+C to stop the server.
echo.

start "" http://localhost:%PAGE_PORT%
npx --yes serve -l %PAGE_PORT% "%~dp0"

endlocal
