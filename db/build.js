/* Build one load-ready CSV per RTO, matching the 9 table columns:
     sr_no, report_month, report_year, application_no,
     vehicle_registration_no, owner_name, dealer_name,
     dealer_address, status

   Two kinds of duplicate have to be resolved here rather than left to
   the UNIQUE constraint, which keeps whichever row reaches it first -
   an arbitrary choice driven by file order.

   1. WITHIN a month, overlapping export windows catch one vehicle mid
      transition: Pending in the earlier snapshot, Fixed in the later.
      One record, so it is collapsed with 'HSRP Fixed' winning.

   2. ACROSS months, only HSRP MAR'26.xlsx produces duplicates. Its
      Source.Name column labels all 33,442 rows as March windows, but
      11,525 carry May-2026 application numbers and 134 carry April -
      a March report cannot contain May applications, so those rows are
      contamination. Every one was verified to be present already in the
      Apr/May folder files, so the per-RTO CSVs win and the workbook
      copy is dropped. Nothing is lost.

      Verified across the 842 per-RTO files: they produce ZERO cross
      month collisions on their own, so keying application numbers
      globally per RTO cannot collapse a legitimate record.

   Rows with no application number stay keyed per period: a pending
   vehicle appearing in two months is two real monthly observations. */

const fs = require('fs'), path = require('path'), L = require('./hsrplib');

const OUT = path.join(__dirname, 'load');
fs.rmSync(OUT, {recursive: true, force: true});
fs.mkdirSync(OUT, {recursive: true});

const {files, skipped} = L.manifest();

// group the file list by RTO
const byRto = new Map();
for (const f of files) (byRto.get(f.rto) || byRto.set(f.rto, []).get(f.rto)).push(f);

// fold MAR'26 in as a virtual per-RTO source, flagged so the dedup below
// can prefer a real per-RTO export over the workbook
const mar = L.readMar26();
for (const [rto, rows] of mar.byRto) {
  (byRto.get(rto) || byRto.set(rto, []).get(rto))
    .push({rel: "HSRP-2026/MAR'26/HSRP MAR'26.xlsx#" + rto, rto,
           year: 2026, month: 3, virtual: rows, workbook: true});
}

function q(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }
const rank = r => (r.workbook ? 0 : 1);          // real export beats workbook
const fixed = r => (r[6] === 'HSRP Fixed' ? 1 : 0);

const report = [], fileLog = [];
let grandRead = 0, grandWrote = 0, grandSame = 0, grandCross = 0;

for (const rto of [...byRto.keys()].sort()) {
  const apps   = new Map();   // application no -> {r, y, m, workbook}
  const blanks = new Map();   // period + registration + owner -> {r, y, m}
  let read = 0, sameMonth = 0, crossMonth = 0;

  for (const f of byRto.get(rto)) {
    const rows = f.virtual || L.readRows(f).rows;
    read += rows.length;
    fileLog.push({rel: f.rel, rto, year: f.year, month: f.month, rows: rows.length});

    for (const r of rows) {
      const app = r[1];
      if (!app) {
        const k = f.year + '|' + f.month + '|' + r[2] + '|' + r[3];
        if (!blanks.has(k)) blanks.set(k, {r, y: f.year, m: f.month});
        continue;
      }
      const cur = {r, y: f.year, m: f.month, workbook: !!f.workbook};
      const prev = apps.get(app);
      if (!prev) { apps.set(app, cur); continue; }

      if (prev.y === cur.y && prev.m === cur.m) sameMonth++; else crossMonth++;

      // prefer a real per-RTO export over the MAR'26 workbook, then
      // 'HSRP Fixed' over 'HSRP Pending', then the later period
      const better =
        rank(cur) !== rank(prev)               ? rank(cur) > rank(prev) :
        fixed(cur.r) !== fixed(prev.r)         ? fixed(cur.r) > fixed(prev.r) :
        (cur.y * 12 + cur.m) > (prev.y * 12 + prev.m);
      if (better) apps.set(app, cur);
    }
  }

  // regroup by period for output
  const periods = new Map();
  const push = ({r, y, m}) => {
    const k = y + '-' + String(m).padStart(2, '0');
    (periods.get(k) || periods.set(k, []).get(k)).push({r, y, m});
  };
  for (const v of apps.values()) push(v);
  for (const v of blanks.values()) push(v);

  const lines = [];
  let wrote = 0;
  for (const pk of [...periods.keys()].sort()) {
    for (const {r, y, m} of periods.get(pk)) {
      const sr = /^\d+$/.test(r[0]) ? r[0] : '';
      lines.push([sr, m, y, r[1], r[2], r[3], r[4], r[5], r[6]].map(q).join(','));
      wrote++;
    }
  }
  fs.writeFileSync(path.join(OUT, 'hsrp_' + rto.toLowerCase() + '.csv'),
                   lines.join('\n') + '\n');

  report.push({rto, files: byRto.get(rto).length, periods: periods.size,
               read, sameMonth, crossMonth, wrote});
  grandRead += read; grandWrote += wrote;
  grandSame += sameMonth; grandCross += crossMonth;
  console.error('  ' + rto + '  ' + wrote.toLocaleString());
}

console.log('RTO    files       read   same-mo  cross-mo      loaded');
for (const r of report)
  console.log(r.rto.padEnd(6) + String(r.files).padStart(5) +
              String(r.read).padStart(11) + String(r.sameMonth).padStart(10) +
              String(r.crossMonth).padStart(10) + String(r.wrote).padStart(12));
console.log('-'.repeat(54));
console.log('TOTAL '.padEnd(6) + String(files.length + mar.byRto.size).padStart(5) +
            String(grandRead).padStart(11) + String(grandSame).padStart(10) +
            String(grandCross).padStart(10) + String(grandWrote).padStart(12));
console.log('\ncollapsed: ' + grandSame + ' same-month, ' + grandCross + ' cross-month');
console.log('skipped files: ' + skipped.length);

fs.writeFileSync('files.json', JSON.stringify(fileLog, null, 1));
fs.writeFileSync('build-report.json', JSON.stringify(
  {report, grandRead, grandWrote, grandSame, grandCross, skipped}, null, 1));
