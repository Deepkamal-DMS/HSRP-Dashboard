-- =====================================================================
--  HSRP Dashboard - Supabase schema
-- =====================================================================
--  Mirrors db/schema.sql, with three differences forced by Supabase
--  being an internet-facing database:
--
--    * roles: Supabase already has anon / authenticated, so the local
--      web_anon + authenticator roles are not created here;
--    * the 12 raw RTO tables carry personal data (owner names, vehicle
--      registration numbers), so they get RLS enabled with NO policy
--      and their grants revoked - the public key cannot read them;
--    * only the aggregates are readable by the public key.
--
--  Supabase grants new public-schema tables to anon by default, which
--  is why the REVOKE below is explicit rather than assumed.
-- =====================================================================


-- ---------------------------------------------------------------------
--  1.  Create the table for one RTO
-- ---------------------------------------------------------------------
--  application_no is UNIQUE but NULLABLE: 246 rows across the 21 files
--  have no application number and every one of them is 'HSRP Pending'.
--  A primary key would reject them and understate Pending by ~6%.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hsrp_ensure_rto_table(p_rto text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (report_year, report_month)',
        v_table || '_period_idx', v_table);
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (status)',
        v_table || '_status_idx', v_table);
    EXECUTE format(
        'CREATE INDEX IF NOT EXISTS %I ON public.%I (dealer_name)',
        v_table || '_dealer_idx', v_table);

    -- personal data: locked down, not readable by the public key
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', v_table);

    RETURN v_table;
END
$$;


-- ---------------------------------------------------------------------
--  2.  The 12 RTOs present today
-- ---------------------------------------------------------------------

SELECT public.hsrp_ensure_rto_table(rto)
FROM unnest(ARRAY[
    'GJ01','GJ02','GJ04','GJ09','GJ13','GJ18',
    'GJ19','GJ24','GJ27','GJ30','GJ33','GJ38'
]) AS rto;


-- ---------------------------------------------------------------------
--  3.  Union view over every RTO table
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.hsrp_rebuild_all_view()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    -- hsrp_all carries the personal columns too: keep it private
    EXECUTE 'REVOKE ALL ON public.hsrp_all FROM anon, authenticated';
END
$$;

SELECT public.hsrp_rebuild_all_view();


-- ---------------------------------------------------------------------
--  4.  Aggregates - the only things the dashboard reads
-- ---------------------------------------------------------------------
--  Dealer x RTO x period counts. No owner names, no registration
--  numbers, no application numbers.
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


GRANT SELECT ON public.hsrp_dealer_summary TO anon, authenticated;
GRANT SELECT ON public.hsrp_load_summary   TO anon, authenticated;
