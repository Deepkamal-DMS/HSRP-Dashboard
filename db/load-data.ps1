<#
    =====================================================================
     HSRP Dashboard - CSV loader
    =====================================================================
     Reads every CSV in ..\HSRP and works out from the FILE NAME alone:

         GJ01-APR-20.csv   ->  table hsrp_gj01, report_month 4, year 2020
         GJ27-APR'26.csv   ->  table hsrp_gj27, report_month 4, year 2026

     One table per RTO.  report_month + report_year are written into
     every row, straight after sr_no; the remaining columns are copied
     from the file as-is.

     The load is idempotent: re-running it replaces that RTO/period
     rather than duplicating it, so a corrected re-export can just be
     dropped in and the script re-run.

     Usage:
         powershell -ExecutionPolicy Bypass -File db\load-data.ps1
         powershell -ExecutionPolicy Bypass -File db\load-data.ps1 -Only GJ01
    =====================================================================
#>

[CmdletBinding()]
param(
    # Load only this RTO (e.g. -Only GJ01).  Default: every file.
    [string] $Only,

    # Empty every RTO table before loading.
    [switch] $Fresh
)

$ErrorActionPreference = 'Stop'

$Container = 'hsrp-db'
$DbUser    = 'hsrp_admin'
$DbName    = 'hsrp'

$CsvDir    = Join-Path (Split-Path -Parent $PSScriptRoot) 'HSRP'
$MountDir  = '/csv'          # where $CsvDir is mounted inside the container

# --- file name grammar -------------------------------------------------
#   GJ + 2 digits, separator ( - or ' ), 3-letter month, separator,
#   2-digit year.  Both separators vary between files; both parse alike.
$NamePattern = "^(?<rto>GJ\d{2})[-'](?<mon>[A-Za-z]{3})[-'](?<yy>\d{2})\.csv$"

$MonthNumber = @{
    JAN = 1;  FEB = 2;  MAR = 3;  APR = 4;  MAY = 5;  JUN = 6
    JUL = 7;  AUG = 8;  SEP = 9;  OCT = 10; NOV = 11; DEC = 12
}

# ----------------------------------------------------------------------
#  helpers
# ----------------------------------------------------------------------

function Invoke-Psql {
    param([string] $Sql, [switch] $Quiet)

    $flags = @('-v', 'ON_ERROR_STOP=1', '-U', $DbUser, '-d', $DbName)
    if ($Quiet) { $flags += @('-t', '-A') }

    $out = $Sql | docker exec -i $Container psql @flags -f -
    if ($LASTEXITCODE -ne 0) {
        throw "psql failed (exit $LASTEXITCODE):`n$out"
    }
    return $out
}

function ConvertTo-SqlLiteral {
    param([string] $Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

# ----------------------------------------------------------------------
#  pre-flight
# ----------------------------------------------------------------------

Write-Host ''
Write-Host 'HSRP data loader' -ForegroundColor Cyan
Write-Host '----------------'

$running = docker ps --filter "name=$Container" --format '{{.Names}}'
if ($running -notcontains $Container) {
    throw "Container '$Container' is not running. Run db\setup-db.bat first."
}

if (-not (Test-Path $CsvDir)) { throw "CSV folder not found: $CsvDir" }

$files = Get-ChildItem -Path $CsvDir -Filter '*.csv' | Sort-Object Name
if ($Only) {
    $files = $files | Where-Object { $_.Name -match "^$Only[-']" }
    if (-not $files) { throw "No files matched RTO '$Only'." }
}

Write-Host ("Source : {0}" -f $CsvDir)
Write-Host ("Files  : {0}" -f $files.Count)
Write-Host ''

if ($Fresh) {
    Write-Host 'Truncating existing RTO tables...' -ForegroundColor Yellow
    Invoke-Psql -Quiet @'
DO $$
DECLARE t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables
             WHERE schemaname = 'public' AND tablename ~ '^hsrp_gj[0-9]{2}$'
    LOOP
        EXECUTE format('TRUNCATE public.%I', t.tablename);
    END LOOP;
END
$$;
'@ | Out-Null
    Write-Host ''
}

# ----------------------------------------------------------------------
#  load
# ----------------------------------------------------------------------

$results  = @()
$skipped  = @()

foreach ($file in $files) {

    if ($file.Name -notmatch $NamePattern) {
        $skipped += [pscustomobject]@{ File = $file.Name; Reason = 'name does not parse' }
        Write-Host ("  SKIP  {0,-18} unrecognised file name" -f $file.Name) -ForegroundColor DarkYellow
        continue
    }

    $rto = $Matches['rto'].ToUpper()
    $mon = $Matches['mon'].ToUpper()
    $yy  = [int] $Matches['yy']

    if (-not $MonthNumber.ContainsKey($mon)) {
        $skipped += [pscustomobject]@{ File = $file.Name; Reason = "unknown month '$mon'" }
        Write-Host ("  SKIP  {0,-18} unknown month '{1}'" -f $file.Name, $mon) -ForegroundColor DarkYellow
        continue
    }

    $month = $MonthNumber[$mon]
    $year  = 2000 + $yy                       # all exports are post-2000
    $table = 'hsrp_' + $rto.ToLower()

    # path as the *server* sees it, single-quotes doubled for SQL
    $inPath = ConvertTo-SqlLiteral "$MountDir/$($file.Name)"

    $sql = @"
BEGIN;

SELECT hsrp_ensure_rto_table('$rto');

CREATE TEMP TABLE stg_load (
    sr_no                    text,
    application_no           text,
    vehicle_registration_no  text,
    owner_name               text,
    dealer_name              text,
    dealer_address           text,
    status                   text
) ON COMMIT DROP;

COPY stg_load FROM $inPath WITH (FORMAT csv, HEADER true);

-- make the load repeatable: this RTO + period is replaced wholesale
DELETE FROM public.$table
 WHERE report_month = $month AND report_year = $year;

INSERT INTO public.$table (
    sr_no, report_month, report_year,
    application_no, vehicle_registration_no, owner_name,
    dealer_name, dealer_address, status
)
SELECT CASE WHEN btrim(sr_no) ~ '^[0-9]+$' THEN btrim(sr_no)::int END,
       $month,
       $year,
       -- blank -> NULL: 'HSRP Pending' rows often have no number yet,
       -- and NULLs are allowed past the UNIQUE constraint
       nullif(btrim(application_no), ''),
       btrim(vehicle_registration_no),
       btrim(owner_name),
       btrim(dealer_name),
       btrim(dealer_address),
       btrim(status)
  FROM stg_load
ON CONFLICT (application_no) DO NOTHING;

-- rows read | rows written | of which have no application no,
-- so a silent conflict cannot hide
SELECT (SELECT count(*) FROM stg_load)::text || '|' ||
       (SELECT count(*) FROM public.$table
         WHERE report_month = $month AND report_year = $year)::text || '|' ||
       (SELECT count(*) FROM public.$table
         WHERE report_month = $month AND report_year = $year
           AND application_no IS NULL)::text;

COMMIT;
"@

    $raw = (Invoke-Psql -Sql $sql -Quiet) -join "`n"
    $line = ($raw -split "`n" | Where-Object { $_ -match '^\d+\|\d+\|\d+$' } | Select-Object -Last 1)

    $parts    = $line -split '\|'
    $read     = [int] $parts[0]
    $inserted = [int] $parts[1]
    $noAppNo  = [int] $parts[2]
    $dropped  = $read - $inserted        # must be 0; non-zero = real data loss

    $note = ''
    if ($noAppNo -gt 0) { $note += "  ($noAppNo with no application no.)" }
    if ($dropped -gt 0) { $note += "  [!] $dropped ROWS LOST - duplicate application no." }

    $colour = if ($dropped -eq 0) { 'Green' } else { 'Red' }
    Write-Host ("  OK    {0,-18} -> {1,-10} {2:D4}-{3:D2}  {4,6} rows{5}" -f `
                    $file.Name, $table, $year, $month, $inserted, $note) `
               -ForegroundColor $colour

    $results += [pscustomobject]@{
        File = $file.Name; Table = $table; Year = $year; Month = $month
        Read = $read; Inserted = $inserted; NoAppNo = $noAppNo; Dropped = $dropped
    }
}

# ----------------------------------------------------------------------
#  rebuild the union view, then report
# ----------------------------------------------------------------------

Write-Host ''
Write-Host 'Rebuilding hsrp_all view...'
Invoke-Psql -Quiet 'SELECT hsrp_rebuild_all_view();' | Out-Null

Write-Host ''
Write-Host 'Summary' -ForegroundColor Cyan
Write-Host '-------'
Write-Host ("Files loaded : {0}" -f $results.Count)
Write-Host ("Rows loaded  : {0:N0}" -f (($results | Measure-Object Inserted -Sum).Sum))

$totalNoApp = ($results | Measure-Object NoAppNo -Sum).Sum
if ($totalNoApp -gt 0) {
    Write-Host ("  of which   : {0:N0} have no Application No (loaded as NULL)" -f $totalNoApp)
}

$totalDropped = ($results | Measure-Object Dropped -Sum).Sum
if ($totalDropped -gt 0) {
    Write-Host ("ROWS LOST    : {0:N0}  - duplicate Application No, investigate" -f $totalDropped) -ForegroundColor Red
}
if ($skipped.Count -gt 0) {
    Write-Host ("Files skipped: {0}" -f $skipped.Count) -ForegroundColor Yellow
    $skipped | ForEach-Object { Write-Host ("   {0} - {1}" -f $_.File, $_.Reason) }
}

Write-Host ''
Write-Host 'Per RTO / period (from the database):'
Invoke-Psql -Sql 'SELECT * FROM hsrp_load_summary ORDER BY rto_code, report_year, report_month;'
Write-Host ''
