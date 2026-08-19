@echo off
setlocal

REM =====================================================================
REM  HSRP Dashboard - one-time database provisioning
REM =====================================================================
REM  Creates the Postgres + PostgREST pair, applies schema.sql and loads
REM  every CSV in ..\HSRP.
REM
REM  Runs on its own ports so the Vehicle Analytics stack (5433 / 3003)
REM  is left completely alone:
REM
REM      hsrp-db    postgres:16   localhost:5434
REM      hsrp-api   postgrest     localhost:3004
REM
REM  Safe to re-run: existing containers are started, not recreated.
REM =====================================================================

set "DB_CONTAINER=hsrp-db"
set "API_CONTAINER=hsrp-api"
set "NETWORK=hsrp-net"
set "VOLUME=hsrp-data"
set "DB_NAME=hsrp"
set "DB_USER=hsrp_admin"
set "DB_PASS=local_admin_pw"
set "PGRST_PASS=postgrest_local_pw"
set "DB_PORT=5434"
set "API_PORT=3004"

REM %~dp0 ends with a backslash
set "CSV_DIR=%~dp0..\HSRP"

echo.
echo HSRP Dashboard - database setup
echo ==============================
echo.

REM --- 0. docker must be up ---------------------------------------------
docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not running. Start Docker Desktop and try again.
    exit /b 1
)

if not exist "%CSV_DIR%" (
    echo [ERROR] CSV folder not found: %CSV_DIR%
    exit /b 1
)

REM --- 1. network -------------------------------------------------------
docker network inspect %NETWORK% >nul 2>&1
if errorlevel 1 (
    echo Creating network %NETWORK%...
    docker network create %NETWORK% >nul
) else (
    echo Network %NETWORK% already exists.
)

REM --- 2. database container --------------------------------------------
docker container inspect %DB_CONTAINER% >nul 2>&1
if errorlevel 1 (
    echo Creating %DB_CONTAINER% on port %DB_PORT%...
    docker run -d ^
        --name %DB_CONTAINER% ^
        --network %NETWORK% ^
        -e POSTGRES_DB=%DB_NAME% ^
        -e POSTGRES_USER=%DB_USER% ^
        -e POSTGRES_PASSWORD=%DB_PASS% ^
        -p %DB_PORT%:5432 ^
        -v %VOLUME%:/var/lib/postgresql/data ^
        -v "%CSV_DIR%":/csv:ro ^
        --restart unless-stopped ^
        postgres:16 >nul
    if errorlevel 1 (
        echo [ERROR] Could not create %DB_CONTAINER%.
        exit /b 1
    )
) else (
    echo Starting existing %DB_CONTAINER%...
    docker start %DB_CONTAINER% >nul 2>&1
)

REM --- 3. wait for postgres --------------------------------------------
REM  Probe over TCP with a real query, not just pg_isready on the socket.
REM  On first run the postgres entrypoint boots a temporary init server
REM  that listens on the unix socket only - pg_isready answers "ready"
REM  there, then the server shuts down to restart for real. Requiring a
REM  successful SELECT over 127.0.0.1 skips that window.
echo Waiting for Postgres...
set /a tries=0
:waitdb
set /a tries+=1
docker exec %DB_CONTAINER% psql -h 127.0.0.1 -U %DB_USER% -d %DB_NAME% -c "SELECT 1" >nul 2>&1
if not errorlevel 1 goto dbready
if %tries% GEQ 60 (
    echo [ERROR] Postgres did not become ready. Check: docker logs %DB_CONTAINER%
    exit /b 1
)
REM  ping, not timeout - "timeout" collides with the GNU coreutils one
REM  when this runs from a shell that puts Git/MSYS on PATH.
ping -n 2 127.0.0.1 >nul 2>&1
goto waitdb
:dbready
echo Postgres is ready.

REM --- 4. schema --------------------------------------------------------
echo Applying schema.sql...
docker exec -i %DB_CONTAINER% psql -v ON_ERROR_STOP=1 -q -U %DB_USER% -d %DB_NAME% -f - < "%~dp0schema.sql"
if errorlevel 1 (
    echo [ERROR] schema.sql failed.
    exit /b 1
)

REM  The authenticator password is set in schema.sql only on first create,
REM  so force it here to stay in step with PGRST_DB_URI below.
docker exec -i %DB_CONTAINER% psql -q -U %DB_USER% -d %DB_NAME% ^
    -c "ALTER ROLE authenticator WITH LOGIN PASSWORD '%PGRST_PASS%';" >nul
echo Schema applied.

REM --- 5. API container -------------------------------------------------
docker container inspect %API_CONTAINER% >nul 2>&1
if errorlevel 1 (
    echo Creating %API_CONTAINER% on port %API_PORT%...
    docker run -d ^
        --name %API_CONTAINER% ^
        --network %NETWORK% ^
        -e PGRST_DB_URI=postgres://authenticator:%PGRST_PASS%@%DB_CONTAINER%:5432/%DB_NAME% ^
        -e PGRST_DB_SCHEMAS=public ^
        -e PGRST_DB_ANON_ROLE=web_anon ^
        -p %API_PORT%:3000 ^
        --restart unless-stopped ^
        postgrest/postgrest >nul
    if errorlevel 1 (
        echo [ERROR] Could not create %API_CONTAINER%.
        exit /b 1
    )
) else (
    echo Starting existing %API_CONTAINER%...
    docker start %API_CONTAINER% >nul 2>&1
)

REM --- 6. load the CSVs -------------------------------------------------
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0load-data.ps1"
if errorlevel 1 (
    echo [ERROR] Data load failed.
    exit /b 1
)

REM --- 7. let PostgREST pick up the new tables --------------------------
docker kill -s SIGUSR1 %API_CONTAINER% >nul 2>&1

echo.
echo Setup complete.
echo    Database : localhost:%DB_PORT%   (%DB_NAME% / %DB_USER%)
echo    API      : http://localhost:%API_PORT%
echo.
echo    Try: curl "http://localhost:%API_PORT%/hsrp_load_summary"
echo.

endlocal
