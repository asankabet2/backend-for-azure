'use strict';

// helpers/bidExcel.js
// Builds the supplier bid template (.xlsx) and parses an uploaded one.
// Pure functions: no database or Express code in here, so they are easy to test.

const ExcelJS = require('exceljs');

const BID_SHEET  = 'Bid';
const INFO_SHEET = 'Instructions';

const COLUMNS = [
    { key: 'itemNo',       header: 'Item No',                  width: 9  },
    { key: 'tenderItemId', header: 'Tender Item ID',           width: 22 },
    { key: 'description',  header: 'Description',              width: 55 },
    { key: 'unit',         header: 'Unit',                     width: 10 },
    { key: 'qty',          header: 'Qty',                      width: 10 },
    { key: 'bid',          header: 'Bid? (Yes/No)',            width: 13 },
    { key: 'price',        header: 'Unit Price (GHS)',         width: 16 },
    { key: 'country',      header: 'Country of Origin',        width: 20 },
    { key: 'pack',         header: 'Pack Size',                width: 18 },
    { key: 'expiry',       header: 'Expiry Date (YYYY-MM-DD)', width: 22 },
    { key: 'total',        header: 'Total (GHS)',              width: 16 },
];
const EDITABLE = ['bid', 'price', 'country', 'pack', 'expiry'];

// Header text -> column key. Matched on the normalised start of the header,
// so small edits like "Unit Price" vs "Unit Price (GHS)" do not break the import.
const HEADER_PREFIX = {
    tenderItemId: 'tenderitemid',
    bid:          'bid',
    price:        'unitprice',
    country:      'countryoforigin',
    pack:         'packsize',
    expiry:       'expirydate',
};

class ImportError extends Error {
    constructor(message) { super(message); this.name = 'ImportError'; }
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pad2 = (n) => String(n).padStart(2, '0');

// ExcelJS cell values can be rich text, formula objects, hyperlinks, etc. Reduce to a plain value.
function plain(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
        if (Array.isArray(v.richText)) return v.richText.map(t => t.text).join('');
        if ('error' in v) return '';
        if ('result' in v) return v.result ?? '';
        if ('text' in v) return v.text ?? '';
    }
    return v;
}

function parsePrice(v) {
    if (typeof v === 'number') return v;
    const s = String(v).replace(/gh[s₵]|₵/gi, '').replace(/[,\s]/g, '');
    return s === '' ? NaN : Number(s);
}

const validYmd = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

// Returns 'YYYY-MM-DD' or null. Accepts Excel dates, Excel serial numbers,
// ISO text, and DD/MM/YYYY text (Ghana convention).
function parseDate(v) {
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);

    if (typeof v === 'number') {
        if (v < 1 || v > 80000) return null;
        return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
    }

    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m && validYmd(+m[1], +m[2], +m[3])) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

    m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
    if (m && validYmd(+m[3], +m[2], +m[1])) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`;

    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template
// ─────────────────────────────────────────────────────────────────────────────
// tender : { id, title, closingDate }
// items  : [{ tenderItemId, itemNo, description, unit, quantity }]  (ordered by itemNo)
// entries: the supplier's current draft, keyed by tenderItemId, used to pre-fill the sheet
async function buildBidTemplate({ tender, items, entries = {}, org = 'Procurement Portal' }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = org;
    wb.created = new Date();

    const ws = wb.addWorksheet(BID_SHEET, { views: [{ state: 'frozen', xSplit: 3, ySplit: 1 }] });
    ws.columns = COLUMNS.map(c => ({ header: c.header, key: c.key, width: c.width }));

    const headerRow = ws.getRow(1);
    headerRow.height = 32;
    headerRow.eachCell((cell, n) => {
        const editable = EDITABLE.includes(COLUMNS[n - 1].key);
        cell.font      = { bold: true, color: { argb: editable ? 'FF000000' : 'FFFFFFFF' } };
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: editable ? 'FFFFE699' : 'FF595959' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
    });

    const LOCKED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };

    items.forEach((it) => {
        const e = entries[it.tenderItemId] || {};
        const price = Number(e.unitPrice) > 0 ? Number(e.unitPrice) : null;
        const qty   = Number(it.quantity);

        const row = ws.addRow({
            itemNo:       it.itemNo,
            tenderItemId: it.tenderItemId,
            description:  it.description || '',
            unit:         it.unit || '',
            qty,
            bid:          e.included === false ? 'No' : 'Yes',
            price,
            country:      e.countryOfOrigin || null,
            pack:         e.packSize || null,
            expiry:       e.expiryDate ? new Date(`${e.expiryDate}T00:00:00Z`) : null,
        });
        const n = row.number;

        row.getCell('total').value = {
            formula: `IF(F${n}="No",0,E${n}*G${n})`,
            result:  e.included === false || !price ? 0 : Math.round(qty * price * 100) / 100,
        };

        // Locked, read-only columns
        ['itemNo', 'tenderItemId', 'description', 'unit', 'qty', 'total'].forEach(k => {
            row.getCell(k).fill = LOCKED_FILL;
            row.getCell(k).protection = { locked: true };
        });
        row.getCell('description').alignment = { wrapText: true, vertical: 'top' };
        row.getCell('qty').numFmt   = '#,##0.##';
        row.getCell('total').numFmt = '#,##0.00';

        // Editable columns
        EDITABLE.forEach(k => { row.getCell(k).protection = { locked: false }; });
        row.getCell('price').numFmt  = '#,##0.00';
        row.getCell('expiry').numFmt = 'yyyy-mm-dd';

    });

    if (items.length > 0) {
        const last = items.length + 1;
        ws.autoFilter = { from: 'A1', to: `K${last}` };

        // One validation per column range (per-cell validations produce overlapping ranges that Excel can reject)
        ws.dataValidations.add(`F2:F${last}`, {
            type: 'list', allowBlank: true, formulae: ['"Yes,No"'],
            showErrorMessage: true, errorTitle: 'Bid?', error: 'Choose Yes or No.',
        });
        ws.dataValidations.add(`G2:G${last}`, {
            type: 'decimal', operator: 'greaterThan', allowBlank: true, formulae: [0],
            showErrorMessage: true, errorTitle: 'Unit price', error: 'Enter a number greater than 0.',
        });
    }

    // Protection is a guard against accidents, not security: no password, and the server validates everything.
    await ws.protect('', {
        selectLockedCells: true, selectUnlockedCells: true,
        formatColumns: true, formatRows: true, autoFilter: true,
    });

    // Instructions sheet (also carries the tender ID that the upload is checked against)
    const info = wb.addWorksheet(INFO_SHEET);
    info.getColumn(1).width = 22;
    info.getColumn(2).width = 100;
    info.addRow(['Bid template', '']);
    info.addRow(['Tender ID', tender.id]);
    info.addRow(['Title', tender.title || '']);
    info.addRow(['Closing date', tender.closingDate ? String(tender.closingDate).slice(0, 10) : '']);
    info.addRow([]);
    info.addRow(['How to fill this in', '']);
    [
        'Work on the "Bid" sheet. Fill only the yellow-headed columns: Bid?, Unit Price, Country of Origin, Pack Size, Expiry Date.',
        'Grey columns are locked. Quantity is fixed to the quantity requested in the tender.',
        'Bid? is Yes by default. Choose No for items you do not want to bid on.',
        'Expiry Date must be a future date. Use the format YYYY-MM-DD (for example 2030-12-31).',
        'Do not change the Tender Item ID values, the header row, or the column order.',
        'Save the file as .xlsx (Excel Workbook), then upload it on the "Price Items" step of the portal.',
        'Uploading updates your saved draft. You review everything on the portal before you submit.',
    ].forEach(t => info.addRow(['', t]));
    info.addRow([]);
    info.addRow(['Example row', 'Bid? Yes  |  Unit Price 12.50  |  Country of Origin India  |  Pack Size 10 x 10 tabs  |  Expiry Date 2030-12-31']);
    info.getRow(1).font = { bold: true, size: 14 };
    info.getRow(6).font = { bold: true };
    info.getColumn(1).font = { bold: true };
    info.getColumn(2).alignment = { wrapText: true, vertical: 'top' };

    return wb;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload parser
// ─────────────────────────────────────────────────────────────────────────────
// buffer : the uploaded file
// opts   : { tenderId, items: [{ tenderItemId, itemNo }], current: {tenderItemId: entry}, today: 'YYYY-MM-DD' }
// returns: { entries, problems, skipped, rowsRead }
//   entries  raw entries keyed by tenderItemId (still needs sanitising before it is stored)
//   problems [{ row, itemNo, message }]  never blocks the import
async function parseBidTemplate(buffer, { tenderId, items, current = {}, today }) {
    today = today || new Date().toISOString().slice(0, 10);

    const wb = new ExcelJS.Workbook();
    try {
        await wb.xlsx.load(buffer);
    } catch {
        throw new ImportError('Could not read this file. Please upload the .xlsx template you downloaded from the portal.');
    }

    const info = wb.getWorksheet(INFO_SHEET);
    if (info) {
        const fileTender = String(plain(info.getCell('B2').value)).trim();
        if (fileTender && fileTender !== tenderId)
            throw new ImportError(`This template was downloaded for tender ${fileTender}, not ${tenderId}. Please download the template for this tender.`);
    }

    const ws = wb.getWorksheet(BID_SHEET) || wb.worksheets[0];
    if (!ws) throw new ImportError('The file has no worksheets.');
    if (ws.rowCount > items.length + 500)
        throw new ImportError('This file has far more rows than the tender has items. Please use the template downloaded for this tender.');

    // Locate columns by header text, not by position
    const col = {};
    ws.getRow(1).eachCell((cell, n) => {
        const h = norm(plain(cell.value));
        for (const [key, prefix] of Object.entries(HEADER_PREFIX)) {
            if (!(key in col) && h.startsWith(prefix)) col[key] = n;
        }
    });
    const missing = Object.keys(HEADER_PREFIX).filter(k => !(k in col));
    if (missing.length > 0)
        throw new ImportError('The header row has been changed. Please use the template downloaded from the portal and do not rename or remove columns.');

    const itemNoById = new Map(items.map(i => [i.tenderItemId, i.itemNo]));
    const entries  = {};
    const problems = [];
    const seen     = new Set();
    let skipped = 0;
    let rowsRead = 0;

    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return;

        const id = String(plain(row.getCell(col.tenderItemId).value)).trim();
        if (!id) return;
        rowsRead++;

        if (!itemNoById.has(id)) {
            problems.push({ row: rowNumber, itemNo: null, message: `Unknown Tender Item ID "${id}". It does not belong to this tender.` });
            return;
        }
        const itemNo = itemNoById.get(id);
        const warn = (message) => problems.push({ row: rowNumber, itemNo, message });

        if (seen.has(id)) { warn('Duplicate row for this item. The first one was used.'); return; }
        seen.add(id);

        // Bid? flag
        const bidRaw = String(plain(row.getCell(col.bid).value)).trim().toLowerCase();
        let included = true;
        if (['no', 'n', 'false', '0'].includes(bidRaw)) included = false;
        else if (bidRaw && !['yes', 'y', 'true', '1'].includes(bidRaw)) warn('"Bid?" must be Yes or No. Treated as Yes.');

        const priceRaw   = plain(row.getCell(col.price).value);
        const countryRaw = String(plain(row.getCell(col.country).value)).trim();
        const packRaw    = String(plain(row.getCell(col.pack).value)).trim();
        const expiryRaw  = plain(row.getCell(col.expiry).value);

        const hasPrice  = priceRaw !== '';
        const hasExpiry = expiryRaw !== '';
        const hasData   = hasPrice || hasExpiry || countryRaw !== '' || packRaw !== '';

        // A blank, untouched row changes nothing. A blank row that already has a saved entry
        // overwrites it (that is how a supplier clears a value).
        if (included && !hasData && current[id] === undefined) { skipped++; return; }

        let unitPrice = 0;
        if (hasPrice) {
            const p = parsePrice(priceRaw);
            if (Number.isFinite(p) && p > 0) unitPrice = p;
            else warn('Unit price must be a number greater than 0.');
        }

        let expiryDate = '';
        if (hasExpiry) {
            const d = parseDate(expiryRaw);
            if (!d) warn('Expiry date not recognised. Use YYYY-MM-DD.');
            else {
                expiryDate = d;
                if (d <= today) warn('Expiry date must be in the future.');
            }
        }

        entries[id] = { included, unitPrice, countryOfOrigin: countryRaw, packSize: packRaw, expiryDate };
    });

    return { entries, problems, skipped, rowsRead };
}

module.exports = { buildBidTemplate, parseBidTemplate, ImportError, BID_SHEET, INFO_SHEET };