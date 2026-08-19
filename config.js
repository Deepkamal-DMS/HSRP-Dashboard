/* ============================================================
   HSRP DASHBOARD - API CONFIGURATION

   The same page runs in two places:

     - on this machine, against the local PostgREST container
     - on GitHub Pages, against Supabase

   It picks between them by hostname, so you never edit code to
   switch. Fill in the "hosted" block once, after creating the
   Supabase project (see README.md).

   ------------------------------------------------------------
   IS IT SAFE TO COMMIT THE anon KEY?

   Yes - that is what it is for. Supabase's anon key is designed
   to sit in public front-end code. It is not a password: what
   it can actually do is decided by Row Level Security on the
   database, and db/supabase-schema.sql grants it SELECT on one
   aggregate table and nothing else.

   What must NEVER be committed is the service_role key or the
   database connection string. Those bypass RLS entirely. The
   publish script reads them from your environment, never from
   a file. .gitignore is set up accordingly.
   ============================================================ */

window.HSRP_CONFIG = {

    /*
     * Local development - the containers from db/setup-db.bat.
     * No key: the API is bound to localhost and read-only.
     */
    local: {
        url: "http://localhost:3004",
        key: null
    },

    /*
     * Production - Supabase. Its REST API is PostgREST, so the
     * dashboard's queries are unchanged; only the base URL and
     * the two auth headers differ.
     *
     * url: https://<project-ref>.supabase.co/rest/v1
     * key: the "anon public" key from
     *      Project Settings -> API Keys
     */
    hosted: {
        url: "https://xbqiyndxnezxlxcfvjwb.supabase.co/rest/v1",
        key: "sb_publishable_gxdQ0pVNWphpiCwoK5GCSw_PS_JzCMn"
    },

    /*
     * Hostnames treated as local. Anything else uses "hosted".
     */
    localHosts: ["localhost", "127.0.0.1", "::1", ""]
};
