const fs = require('fs'), path = require('path'), XLSX = require('xlsx');

const MON = {JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12};
const ROOT = "C:/Users/ADMIN/Desktop/HSRP Dashboard/HSRP";
const HEADER = ["S.No.","Application No","Vehicle Registration No","Owner Name",
                "Dealer Name","Dealer Address","Status"];

// Files that are byte-identical copies of another file, or otherwise
// mis-named, and must not be loaded a second time.
const EXCLUDE = new Set([
  // identical to GJ24-01.10-02.10.csv; the content is 318/325 GJ24
  // registrations, so it is a mis-copy, not a GJ27 export.
  "HSRP-2024/OCT-24/GJ27-01.10-02.10.csv",
  // byte-identical to the copy in JUN'26; loaded there, as June.
  "HSRP-2026/JUL'26/GJ08-Jun 2026.xlsx",
]);

// --- RFC4180-ish CSV parser -------------------------------------------
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- read one data file -> array of 7-col string rows ------------------
function readRows(file) {
  let rows;
  if (file.ext === '.xlsx') {
    const wb = XLSX.readFile(file.full);
    const sh = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sh, {header: 1, raw: false, defval: ''});
  } else {
    rows = parseCsv(fs.readFileSync(file.full, 'utf8'));
  }
  rows = rows.filter(r => r.some(c => String(c).trim() !== ''));
  if (!rows.length) return {rows: [], header: null};
  const header = rows[0].map(c => String(c).trim());
  // header must be the known 7 columns (Source.Name variants handled by caller)
  return {rows: rows.slice(1).map(r => {
    const o = [];
    for (let i = 0; i < 7; i++) o.push(String(r[i] === undefined ? '' : r[i]).trim());
    return o;
  }), header};
}

// --- build the manifest ------------------------------------------------
function manifest() {
  const files = [], skipped = [];
  for (const yearDir of ['HSRP-2024','HSRP-2025','HSRP-2026']) {
    const year = parseInt(yearDir.slice(5), 10);
    for (const monDir of fs.readdirSync(path.join(ROOT, yearDir)).sort()) {
      const month = MON[monDir.slice(0,3).toUpperCase()];
      if (!month) { skipped.push({rel: yearDir+'/'+monDir, why:'folder month unparsed'}); continue; }
      for (const name of fs.readdirSync(path.join(ROOT, yearDir, monDir)).sort()) {
        const rel = yearDir+'/'+monDir+'/'+name;
        const m = /^(GJ\d{2})/i.exec(name);
        if (!m) { skipped.push({rel, why:'combined monthly workbook'}); continue; }
        if (EXCLUDE.has(rel)) { skipped.push({rel, why:'duplicate / mis-named copy'}); continue; }
        files.push({rel, name, full: path.join(ROOT, yearDir, monDir, name),
                    rto: m[1].toUpperCase(), year, month,
                    ext: path.extname(name).toLowerCase()});
      }
    }
  }
  return {files, skipped};
}

module.exports = {MON, ROOT, HEADER, EXCLUDE, parseCsv, readRows, manifest};

// --- MAR'26: only the combined workbook survives, but it carries a
// --- Source.Name column naming the per-RTO CSV each row came from,
// --- so the per-RTO split is recoverable.
const MAR26 = path.join(ROOT, "HSRP-2026", "MAR'26", "HSRP MAR'26.xlsx");

function readMar26() {
  const wb = XLSX.readFile(MAR26);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],
                                        {header: 1, raw: false, defval: ''});
  const header = rows[0].map(c => String(c).trim());
  if (header[0] !== 'Source.Name' || header.slice(1,8).join('|') !== HEADER.join('|'))
    throw new Error("MAR'26 workbook header changed: " + JSON.stringify(header));

  const out = new Map();     // rto -> rows
  let unparsed = 0;
  for (const r of rows.slice(1)) {
    const cells = [];
    for (let i = 0; i < 8; i++) cells.push(String(r[i] === undefined ? '' : r[i]).trim());
    if (cells.slice(1).every(c => c === '')) continue;   // blank filler row
    const m = /^(GJ\d{2})/i.exec(cells[0]);
    if (!m) { unparsed++; continue; }
    const rto = m[1].toUpperCase();
    (out.get(rto) || out.set(rto, []).get(rto)).push(cells.slice(1));
  }
  return {byRto: out, unparsed};
}

module.exports.MAR26 = MAR26;
module.exports.readMar26 = readMar26;
