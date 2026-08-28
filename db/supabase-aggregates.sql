-- =====================================================================
--  HSRP Dashboard - aggregate materialisation + lookup indexes
-- =====================================================================
--  Applied after the 2024-2026 folder load took the raw tables from
--  ~99,600 rows to ~1,359,800.  At the old size both of these worked as
--  plain views; at the new size both exceed Supabase's statement
--  timeout and return 500 to the dashboard.
--
--    * hsrp_dealer_summary was a VIEW over hsrp_all, a 12-way UNION
--      ALL.  The dashboard pages through it 1,000 rows at a time, and
--      every page re-computed the whole 1.36M-row aggregate before
--      slicing.  74,216 summary rows = 75 pages = 75 full aggregations.
--      Now a MATERIALIZED VIEW: computed once, read as a table.
--
--    * hsrp_lookup_registration filters on
--      upper(replace(btrim(vehicle_registration_no), ' ', '')), which
--      no plain column index can serve, so it seq-scanned all 12
--      tables.  An expression index per table matches it exactly.
--
--  Re-run after every load, or just call hsrp_refresh_aggregates().
-- =====================================================================


-- ---------------------------------------------------------------------
--  1.  Expression index behind the registration lookup
-- ---------------------------------------------------------------------

DO $$
DECLARE t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables
             WHERE schemaname = 'public' AND tablename ~ '^hsrp_gj[0-9]{2}$'
    LOOP
        EXECUTE format(
            'CREATE INDEX IF NOT EXISTS %I ON public.%I '
            '((upper(replace(btrim(vehicle_registration_no), '' '', ''''))))',
            t.tablename || '_regnorm_idx', t.tablename);
    END LOOP;
END
$$;


-- ---------------------------------------------------------------------
--  2.  Dealer summary as a materialized view
-- ---------------------------------------------------------------------
--  Same columns and same name the dashboard already fetches, so no
--  front-end change is needed.  PostgREST exposes a matview exactly
--  like a view.
-- ---------------------------------------------------------------------

--  The object may exist as either kind, and "DROP MATERIALIZED VIEW IF
--  EXISTS" still errors when it finds a plain view (and vice versa), so
--  the drop has to read relkind first.
DO $$
DECLARE k char;
BEGIN
    SELECT relkind INTO k FROM pg_class
     WHERE oid = 'public.hsrp_dealer_summary'::regclass;
    IF k = 'm' THEN
        DROP MATERIALIZED VIEW public.hsrp_dealer_summary;
    ELSIF k = 'v' THEN
        DROP VIEW public.hsrp_dealer_summary;
    END IF;
EXCEPTION WHEN undefined_table THEN
    NULL;
END
$$;

CREATE MATERIALIZED VIEW public.hsrp_dealer_summary AS
SELECT rto_code,
       report_year,
       report_month,
       coalesce(nullif(btrim(dealer_name), ''), '(Unknown Dealer)') AS dealer_name,
       count(*)::int                                          AS total,
       (count(*) FILTER (WHERE status = 'HSRP Fixed'))::int    AS fixed,
       (count(*) FILTER (WHERE status = 'HSRP Pending'))::int  AS pending
FROM public.hsrp_all
GROUP BY 1, 2, 3, 4;

--  UNIQUE so the view can be refreshed CONCURRENTLY (no read lock), and
--  it is the dashboard's paging order, so paging is an index scan.
CREATE UNIQUE INDEX hsrp_dealer_summary_key
    ON public.hsrp_dealer_summary (rto_code, report_year, report_month, dealer_name);


-- ---------------------------------------------------------------------
--  3.  Load summary as a materialized view
-- ---------------------------------------------------------------------

DO $$
DECLARE k char;
BEGIN
    SELECT relkind INTO k FROM pg_class
     WHERE oid = 'public.hsrp_load_summary'::regclass;
    IF k = 'm' THEN
        DROP MATERIALIZED VIEW public.hsrp_load_summary;
    ELSIF k = 'v' THEN
        DROP VIEW public.hsrp_load_summary;
    END IF;
EXCEPTION WHEN undefined_table THEN
    NULL;
END
$$;

CREATE MATERIALIZED VIEW public.hsrp_load_summary AS
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

CREATE UNIQUE INDEX hsrp_load_summary_key
    ON public.hsrp_load_summary (rto_code, report_year, report_month);


-- ---------------------------------------------------------------------
--  4.  Grants - the aggregates carry no personal data
-- ---------------------------------------------------------------------

GRANT SELECT ON public.hsrp_dealer_summary TO anon, authenticated;
GRANT SELECT ON public.hsrp_load_summary   TO anon, authenticated;


-- ---------------------------------------------------------------------
--  5.  Refresh helper - call after every load
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hsrp_refresh_aggregates()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.hsrp_dealer_summary;
    REFRESH MATERIALIZED VIEW CONCURRENTLY public.hsrp_load_summary;
END
$$;

REVOKE ALL ON FUNCTION public.hsrp_refresh_aggregates() FROM anon, authenticated;


-- ---------------------------------------------------------------------
--  6.  Registration lookup - stop the LIMIT from picking a bad plan
-- ---------------------------------------------------------------------
--  The body is unchanged in what it returns.  The only difference is
--  that the filter is fenced inside a MATERIALIZED CTE.
--
--  Without the fence, "ORDER BY report_year, report_month LIMIT 10"
--  invited a fast-start plan: walk hsrp_all in period order using the
--  _period_idx indexes and stop once 10 rows match.  With ~1.36M rows
--  and exactly one match, that walks nearly the whole table - 12.9s,
--  past the statement timeout, so the dashboard got a 500.  The same
--  filter run on its own is ~70ms on the _regnorm_idx expression index.
--
--  MATERIALIZED forces the filter first, then sorts the handful of
--  rows it returns.
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
    WITH hits AS MATERIALIZED (
        SELECT a.rto_code, a.sr_no, a.report_month, a.report_year,
               a.application_no, a.vehicle_registration_no, a.owner_name,
               a.dealer_name, a.dealer_address, a.status
        FROM public.hsrp_all a
        WHERE length(btrim(coalesce(p_reg, ''))) >= 7
          AND upper(replace(btrim(a.vehicle_registration_no), ' ', ''))
            = upper(replace(btrim(p_reg), ' ', ''))
    )
    SELECT * FROM hits
    ORDER BY report_year, report_month
    LIMIT 10;
$fn$;

GRANT EXECUTE ON FUNCTION public.hsrp_lookup_registration(text) TO anon, authenticated;
