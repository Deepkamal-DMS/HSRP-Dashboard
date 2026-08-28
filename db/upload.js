/* Load load/hsrp_gjNN.csv into Supabase.

   No table is ever created.  The set of hsrp_gjNN tables already in the
   database decides what gets loaded: an RTO with no table is skipped
   whole, and every source file behind it is recorded as not-uploaded.

   Connection string comes from db/connection-string.txt (gitignored) or
   $HSRP_PG_URL, so it never reaches argv or the shell history.

   Each RTO is one transaction: COPY into a staging table, drop the
   periods that staging covers, insert.  Periods NOT in the folders
   (the April 2020 GJ01 export already loaded) are left alone.        */

const fs = require('fs'), path = require('path');
const {Client} = require('pg');
const copyFrom = require('pg-copy-streams').from;
const {pipeline} = require('stream/promises');

const CS  = "C:/Users/ADMIN/Desktop/HSRP Dashboard/db/connection-string.txt";
const URL = process.env.HSRP_PG_URL ||
            (fs.existsSync(CS) ? fs.readFileSync(CS, 'utf8').trim() : null);
if (!URL) {
  console.error('No connection string: write db/connection-string.txt or set HSRP_PG_URL');
  process.exit(1);
}

const LOAD   = path.join(__dirname, 'load');
const DRYRUN = process.argv.includes('--dry-run');
const files  = require('./files.json');        // every source file, with its RTO

// The folders are the complete history for the months they cover, so a
// reload must clear that whole span - not merely the periods staging
// happens to contain. A period can legitimately end up EMPTY after the
// dedup (GJ02 March 2026 was entirely May rows mislabelled by the
// MAR'26 workbook); scoping the delete to staged periods would leave
// the previous run's rows sitting there, holding the application
// numbers the real month needs. Periods outside the span - the April
// 2020 GJ01 export already in the database - are untouched.
const SPAN = files.reduce((a, f) => {
  const k = f.year * 12 + f.month;
  return {lo: Math.min(a.lo, k), hi: Math.max(a.hi, k)};
}, {lo: Infinity, hi: -Infinity});

const COLS = `sr_no, report_month, report_year, application_no,
              vehicle_registration_no, owner_name, dealer_name,
              dealer_address, status`;

const TABLE_RE = "'^hsrp_gj[0-9]{2}$'";

(async () => {
  const c = new Client({connectionString: URL, ssl: {rejectUnauthorized: false},
                        statement_timeout: 0, query_timeout: 0});
  await c.connect();

  // ---- what tables actually exist -----------------------------------
  const existing = new Set((await c.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'" +
      " AND tablename ~ " + TABLE_RE
    )).rows.map(r => r.tablename.replace('hsrp_', '').toUpperCase()));

  const staged = fs.readdirSync(LOAD).filter(f => f.endsWith('.csv')).sort()
                   .map(f => f.replace('hsrp_', '').replace('.csv', '').toUpperCase());

  const loadable = staged.filter(r => existing.has(r));
  const missing  = staged.filter(r => !existing.has(r));

  console.log('tables in database : ' + [...existing].sort().join(' ') + '  (' + existing.size + ')');
  console.log('RTOs in the folders: ' + staged.length);
  console.log('  will load        : ' + loadable.length + '  ' + loadable.join(' '));
  console.log('  no table, skipped: ' + missing.length + '  ' + missing.join(' '));
  console.log('');

  const done = [], undone = [];
  const filesFor = rto => files.filter(f => f.rto === rto);

  for (const rto of missing) {
    for (const f of filesFor(rto)) {
      undone.push(Object.assign({}, f,
        {reason: 'no table hsrp_' + rto.toLowerCase() + ' in database'}));
    }
  }

  if (DRYRUN) {
    await c.end();
    return report(done, undone, loadable, missing, true);
  }

  // ---- load ----------------------------------------------------------
  let grand = 0, grandRejected = 0;
  for (const rto of loadable) {
    const table = 'hsrp_' + rto.toLowerCase();
    const file  = path.join(LOAD, table + '.csv');
    const t0 = Date.now();
    try {
      await c.query('BEGIN');
      await c.query('CREATE TEMP TABLE stg (' +
        'sr_no integer, report_month smallint, report_year smallint,' +
        'application_no text, vehicle_registration_no text, owner_name text,' +
        'dealer_name text, dealer_address text, status text) ON COMMIT DROP');

      await pipeline(
        fs.createReadStream(file),
        c.query(copyFrom('COPY stg (' + COLS + ') FROM STDIN WITH (FORMAT csv)')));

      const n = (await c.query('SELECT count(*)::int n FROM stg')).rows[0].n;

      const del = await c.query('DELETE FROM public.' + table +
        ' WHERE report_year * 12 + report_month BETWEEN $1 AND $2',
        [SPAN.lo, SPAN.hi]);

      // blank application numbers go in as NULL - the UNIQUE index would
      // otherwise treat every blank as one and the same value
      const ins = await c.query(
        'INSERT INTO public.' + table + ' (' + COLS + ')' +
        " SELECT sr_no, report_month, report_year, nullif(btrim(application_no), '')," +
        ' vehicle_registration_no, owner_name, dealer_name, dealer_address, status' +
        ' FROM stg ON CONFLICT (application_no) DO NOTHING');
      await c.query('COMMIT');

      const rejected = n - ins.rowCount;
      grand += ins.rowCount;
      grandRejected += rejected;
      for (const f of filesFor(rto)) done.push(f);

      console.log('  ' + rto + '  staged ' + String(n).padStart(7) +
                  '  inserted ' + String(ins.rowCount).padStart(7) +
                  '  cleared ' + String(del.rowCount).padStart(7) +
                  (rejected ? '  [!] ' + rejected + ' rejected' : '') +
                  '   ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      await c.query('ROLLBACK').catch(function () {});
      for (const f of filesFor(rto)) {
        undone.push(Object.assign({}, f, {reason: 'load failed: ' + e.message}));
      }
      console.log('  ' + rto + '  FAILED: ' + e.message);
    }
  }

  console.log('\nrebuilding views...');
  await c.query('SELECT public.hsrp_rebuild_all_view()');

  // hsrp_dealer_summary / hsrp_load_summary are MATERIALIZED (see
  // db/supabase-aggregates.sql) - as plain views the dashboard's paging
  // timed out at this row count. They hold the PREVIOUS load until
  // refreshed, so this is not optional.
  console.log('refreshing aggregates...');
  const t0 = Date.now();
  await c.query('SELECT public.hsrp_refresh_aggregates()');
  console.log('  done in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  console.log('rows inserted: ' + grand.toLocaleString() +
              (grandRejected ? '   rejected: ' + grandRejected : ''));
  await c.end();
  report(done, undone, loadable, missing, false);
})().catch(function (e) { console.error('FAILED: ' + e.message); process.exit(1); });


function report(done, undone, loadable, missing, dry) {
  const sum = a => a.reduce((s, f) => s + f.rows, 0);

  fs.writeFileSync('upload-report.json', JSON.stringify(
    {dryRun: dry, loadedRtos: loadable, skippedRtos: missing,
     uploaded: done, notUploaded: undone}, null, 1));

  const lines = ['status,rto,report_year,report_month,rows,file,reason'];
  for (const f of done) {
    lines.push(['uploaded', f.rto, f.year, f.month, f.rows, '"' + f.rel + '"', ''].join(','));
  }
  for (const f of undone) {
    lines.push(['NOT UPLOADED', f.rto, f.year, f.month, f.rows,
                '"' + f.rel + '"', '"' + f.reason + '"'].join(','));
  }
  fs.writeFileSync('upload-report.csv', lines.join('\n') + '\n');

  if (dry) console.log('\nDRY RUN - nothing written to the database');
  console.log('\nfiles uploaded     : ' + done.length +
              '   (' + sum(done).toLocaleString() + ' source rows)');
  console.log('files NOT uploaded : ' + undone.length +
              '   (' + sum(undone).toLocaleString() + ' source rows)');

  const byRto = {};
  undone.forEach(f => {
    byRto[f.rto] = byRto[f.rto] || {n: 0, rows: 0, why: f.reason};
    byRto[f.rto].n++;
    byRto[f.rto].rows += f.rows;
  });
  if (Object.keys(byRto).length) {
    console.log('\nnot uploaded, by RTO:');
    Object.keys(byRto).sort().forEach(r =>
      console.log('   ' + r + '  ' + String(byRto[r].n).padStart(3) + ' files  ' +
                  String(byRto[r].rows).padStart(7) + ' rows   ' + byRto[r].why));
  }
  console.log('\nwritten: upload-report.csv  /  upload-report.json');
}
