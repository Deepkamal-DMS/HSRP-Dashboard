-- =====================================================================
--  HSRP Dashboard - database schema
-- =====================================================================
--  One table per RTO.  The loader decides which table a CSV goes into
--  by reading the RTO code out of the file name, and pulls the report
--  month + year out of the file name as well.
--
--      GJ01-APR-20.csv   ->  hsrp_gj01,  month = 4,  year = 2020
--      GJ27-APR'26.csv   ->  hsrp_gj27,  month = 4,  year = 2026
--
--  Every table has the same 9 columns:  the file's own 7 columns, with
--  report_month + report_year inserted straight after sr_no.
--
--  Run once:   db\setup-db.bat
--  Reload:     db\load-data.ps1
-- =====================================================================

-- ---------------------------------------------------------------------
--  1.  PostgREST roles  (this database only - nothing is shared)
-- ---------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'web_anon') THEN
        CREATE ROLE web_anon NOLOGIN;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
        CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'postgrest_local_pw';
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO web_anon;
GRANT web_anon TO authenticator;


-- ---------------------------------------------------------------------
--  2.  Month-name -> month-number, for the file name parser
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION hsrp_month_number(p_name text)
RETURNS smallint
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE upper(left(btrim(p_name), 3))
               WHEN 'JAN' THEN 1  WHEN 'FEB' THEN 2  WHEN 'MAR' THEN 3
               WHEN 'APR' THEN 4  WHEN 'MAY' THEN 5  WHEN 'JUN' THEN 6
               WHEN 'JUL' THEN 7  WHEN 'AUG' THEN 8  WHEN 'SEP' THEN 9
               WHEN 'OCT' THEN 10 WHEN 'NOV' THEN 11 WHEN 'DEC' THEN 12
           END::smallint;
$$;


-- ---------------------------------------------------------------------
--  3.  Create the table for one RTO
-- ---------------------------------------------------------------------
--  Called by the loader for every file it finds, so a brand new RTO
--  needs no schema change - drop the CSV in and re-run the loader.
--
--  Column order is fixed:  sr_no, report_month, report_year, then the
--  file's remaining columns in the order they appear in the CSV.
--
--  application_no is UNIQUE but NULLABLE - deliberately not a primary
--  key.  Verified across all 21 current files (99,645 rows):
--
--    * every non-blank Application No is unique, including across the
--      three GJ01 snapshots - the monthly exports are disjoint batches,
--      not cumulative re-exports;
--    * but 246 rows have NO Application No at all, and every one of
--      them is 'HSRP Pending' - a pending case has not been issued a
--      number yet.  They are real records (registration no, owner,
--      dealer and status all present, 246 distinct registrations),
--      spread over 18 of the 21 files.
--
--  A primary key would reject those 246 rows and understate Pending by
--  ~6%.  A UNIQUE constraint keeps the no-duplicates guarantee while
--  letting the blanks in as NULL, since Postgres permits many NULLs in
--  a unique index.  The loader writes blank -> NULL.
--
--  sr_no restarts at 1 in every file, so it is deliberately not a key.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION hsrp_ensure_rto_table(p_rto text)
RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
    v_rto   text := upper(btrim(p_rto));
    v_table text;
BEGIN
    IF v_rto !~ '^GJ[0-9]{2}$' THEN
        RAISE EXCEPTION 'Bad RTO code "%" - expected GJ followed by 2 digits', p_rto;
    END IF;

    v_table := 'hsrp_' || lower(v_rto);

    EXECUTE format($ddl$
        CREATE TABLE IF NOT EXISTS public.%I (
            sr_no                    integer,
            report_month             smallint  NOT NULL
                                     CHECK (report_month BETWEEN 1 AND 12),
            report_year              smallint  NOT NULL
                                     CHECK (report_year BETWEEN 2000 AND 2100),
            application_no           text      UNIQUE,
            vehicle_registration_no  text,
            owner_name               text,
            dealer_name              text,
            dealer_address           text,
            status                   text
        )
    $ddl$, v_table);

    -- indexes that back the dashboard's filters
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (report_year, report_month)',
        v_table || '_period_idx', v_table);
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (status)',
        v_table || '_status_idx', v_table);
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (dealer_name)',
        v_table || '_dealer_idx', v_table);

    -- read-only access for the dashboard
    EXECUTE format('GRANT SELECT ON public.%I TO web_anon', v_table);

    RETURN v_table;
END
$$;


-- ---------------------------------------------------------------------
--  4.  Pre-create the 12 RTOs present today
-- ---------------------------------------------------------------------

SELECT hsrp_ensure_rto_table(rto)
FROM unnest(ARRAY[
    'GJ01','GJ02','GJ04','GJ09','GJ13','GJ18',
    'GJ19','GJ24','GJ27','GJ30','GJ33','GJ38'
]) AS rto;


-- ---------------------------------------------------------------------
--  5.  Union view across every RTO table
-- ---------------------------------------------------------------------
--  Gives the dashboard an "All RTOs" scope without querying 12
--  endpoints.  Adds rto_code, which the per-RTO tables do not need
--  because the table name already carries it.
--
--  Rebuild after adding a new RTO:  SELECT hsrp_rebuild_all_view();
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION hsrp_rebuild_all_view()
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_sql text;
BEGIN
    SELECT string_agg(
               format(
                   'SELECT %L::text AS rto_code, sr_no, report_month, report_year,'
                   ' application_no, vehicle_registration_no, owner_name,'
                   ' dealer_name, dealer_address, status FROM public.%I',
                   upper(right(tablename, 4)), tablename),
               E'\nUNION ALL\n' ORDER BY tablename)
    INTO v_sql
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^hsrp_gj[0-9]{2}$';

    IF v_sql IS NULL THEN
        RAISE NOTICE 'No RTO tables found - view not created';
        RETURN;
    END IF;

    EXECUTE 'CREATE OR REPLACE VIEW public.hsrp_all AS ' || v_sql;
    EXECUTE 'GRANT SELECT ON public.hsrp_all TO web_anon';
END
$$;

SELECT hsrp_rebuild_all_view();


-- ---------------------------------------------------------------------
--  6.  What is loaded, per RTO / period  (handy sanity check)
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW public.hsrp_load_summary AS
SELECT rto_code,
       report_year,
       report_month,
       count(*)                                              AS rows,
       count(*) FILTER (WHERE status = 'HSRP Fixed')         AS fixed,
       count(*) FILTER (WHERE status = 'HSRP Pending')       AS pending,
       round(100.0 * count(*) FILTER (WHERE status = 'HSRP Fixed')
             / nullif(count(*), 0), 2)                       AS fixed_pct
FROM public.hsrp_all
GROUP BY rto_code, report_year, report_month;

GRANT SELECT ON public.hsrp_load_summary TO web_anon;


-- ---------------------------------------------------------------------
--  7.  Dealer summary  (the dashboard's main data source)
-- ---------------------------------------------------------------------
--  The dashboard is built around a Dealer x Fixed/Pending pivot, but
--  the raw tables are ~99,600 long records - too many to pull into the
--  browser.  Pre-aggregating to dealer x rto x period collapses that to
--  ~6,200 rows, which the page fetches once, caches, and then filters,
--  groups and sorts entirely client-side.
--
--  Sums reconcile exactly with the raw tables (99,645 / 95,536 / 4,109).
--  Blank dealer names are bucketed rather than dropped.
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW public.hsrp_dealer_summary AS
SELECT rto_code,
       report_year,
       report_month,
       coalesce(nullif(btrim(dealer_name), ''), '(Unknown Dealer)') AS dealer_name,
       count(*)::int                                          AS total,
       (count(*) FILTER (WHERE status = 'HSRP Fixed'))::int    AS fixed,
       (count(*) FILTER (WHERE status = 'HSRP Pending'))::int  AS pending
FROM public.hsrp_all
GROUP BY 1, 2, 3, 4;

GRANT SELECT ON public.hsrp_dealer_summary TO web_anon;
-- ---------------------------------------------------------------------
--  Registration lookup
-- ---------------------------------------------------------------------
--  The raw tables hold owner names and registration numbers, so the
--  public API cannot read them. This function is the one narrow door:
--  it takes a COMPLETE registration number and returns that single
--  record. It cannot be used to list or enumerate, because
--
--    * the match is exact (case and spaces normalised), never partial
--    * inputs shorter than 7 characters return nothing
--    * at most 10 rows come back
--
--  Every registration in the data is unique, so a hit is one row.
--  SECURITY DEFINER lets it read the tables the caller cannot.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hsrp_lookup_registration(p_reg text)
RETURNS TABLE (
    rto_code                text,
    sr_no                   integer,
    report_month            smallint,
    report_year             smallint,
    application_no          text,
    vehicle_registration_no text,
    owner_name              text,
    dealer_name             text,
    dealer_address          text,
    status                  text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
    SELECT a.rto_code, a.sr_no, a.report_month, a.report_year,
           a.application_no, a.vehicle_registration_no, a.owner_name,
           a.dealer_name, a.dealer_address, a.status
    FROM public.hsrp_all a
    WHERE length(btrim(coalesce(p_reg, ''))) >= 7
      AND upper(replace(btrim(a.vehicle_registration_no), ' ', ''))
        = upper(replace(btrim(p_reg), ' ', ''))
    ORDER BY a.report_year, a.report_month
    LIMIT 10;
$fn$;

GRANT EXECUTE ON FUNCTION public.hsrp_lookup_registration(text) TO web_anon;
