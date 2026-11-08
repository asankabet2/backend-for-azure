'use strict';

const express    = require('express');
const router     = express.Router();
const PDFDocument = require('pdfkit');
const path = require('path');
const fs   = require('fs');
const multer = require('multer');
const bidXlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const { requireAuth, requireAdmin }   = require('../middleware/auth');
const { getPool, sql }                = require('../db/procurement');
const { createNotification, getAdminUserIds, getSupplierUserId } = require('../helpers/notifications');
const { generateId }                  = require('../utils/idGenerator');
const { logAudit }                    = require('../helpers/audit');
const { sendTemplatedEmail }          = require('../helpers/mailers');
const { checkAwardEligibility }       = require('../helpers/evaluationHelpers');
const { buildBidTemplate, parseBidTemplate, ImportError } = require('../helpers/bidExcel');



// ── 1. GET /api/bids  — admin: all bids
router.get('/', requireAdmin, async (req, res) => {
    try {
        const pool   = await getPool();
        const result = await pool.request().query(`
            SELECT
                b.BidID          AS bidId,
                b.TenderID       AS tenderId,
                t.Title          AS tenderTitle,
                b.SupplierID     AS supplierId,
                sp.CompanyName   AS supplierName,
                b.SubmittedDate  AS submittedDate,
                b.GrandTotal     AS grandTotal,
                bs.BidStatusName AS status,
                b.CreatedAt
            FROM Bid b
            JOIN Tender          t  ON b.TenderID   = t.TenderID
            JOIN SupplierProfile sp ON b.SupplierID  = sp.SupplierID
            JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
            ORDER BY b.CreatedAt DESC
        `);

        const bids           = result.recordset;
        const allItemsResult = await pool.request().query(`
            SELECT
                BidID        AS bidId,
                ItemNo       AS itemNo,
                TenderItemID AS tenderItemId,
                Description, Unit, Quantity, UnitPrice, Total,
                CountryOfOrigin AS countryOfOrigin,
                PackSize        AS packSize,
                ExpiryDate      AS expiryDate
            FROM BidItem
            ORDER BY BidID, ItemNo, TenderItemID ASC
        `);

        const itemMap = {};
        allItemsResult.recordset.forEach(row => {
            if (!itemMap[row.bidId]) itemMap[row.bidId] = [];
            itemMap[row.bidId].push(row);
        });
        bids.forEach(bid => { bid.items = itemMap[bid.bidId] || []; });

        res.json(bids);
    } catch (error) {
        console.error('[GET /api/bids] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── 2. GET /api/bids/tender/:tenderId  — admin: bids for a specific tender
router.get('/tender/:tenderId', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    try {
        const pool       = await getPool();
        const bidsResult = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT
                    b.BidID          AS bidId,
                    b.TenderID       AS tenderId,
                    b.SupplierID     AS supplierId,
                    sp.CompanyName   AS supplierName,
                    b.SubmittedDate  AS submittedDate,
                    b.GrandTotal     AS grandTotal,
                    bs.BidStatusName AS status,
                    b.ComplianceScore,
                    b.EvaluationScore,
                    b.CreatedAt
                FROM Bid b
                JOIN SupplierProfile sp ON b.SupplierID  = sp.SupplierID
                JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
                WHERE b.TenderID = @tenderId
                ORDER BY b.SubmittedDate DESC
            `);

        const bids = bidsResult.recordset;

        if (bids.length > 0) {
            const itemsRequest = pool.request();
            const placeholders = bids.map((b, i) => {
                itemsRequest.input(`bid${i}`, sql.VarChar(50), b.bidId);
                return `@bid${i}`;
            }).join(',');

            const allItemsResult = await itemsRequest.query(`
                SELECT
                    BidID        AS bidId,
                    ItemNo       AS itemNo,
                    TenderItemID AS tenderItemId,
                    Description, Unit, Quantity, UnitPrice, Total,
                    CountryOfOrigin AS countryOfOrigin,
                    PackSize        AS packSize,
                    ExpiryDate      AS expiryDate
                    FROM BidItem
                WHERE BidID IN (${placeholders})
                ORDER BY BidID, ItemNo, TenderItemID ASC
            `);

            const itemMap = {};
            allItemsResult.recordset.forEach(row => {
                if (!itemMap[row.bidId]) itemMap[row.bidId] = [];
                itemMap[row.bidId].push(row);
            });
            bids.forEach(bid => { bid.items = itemMap[bid.bidId] || []; });
        }

        res.json(bids);
    } catch (error) {
        console.error('[GET /api/bids/tender/:tenderId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── 3. GET /api/bids/supplier/:supplierId  — supplier: their own bids
router.get('/supplier/:supplierId', requireAuth, async (req, res) => {
    const { supplierId }   = req.params;
    const { userId, role } = req.user;

    if (role === 'supplier' && userId !== supplierId)
        return res.status(403).json({ message: 'You can only view your own bids' });

    try {
        const pool       = await getPool();
        const bidsResult = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`
                SELECT
                    b.BidID          AS bidId,
                    b.TenderID       AS tenderId,
                    t.Title          AS tenderTitle,
                    b.SupplierID     AS supplierId,
                    sp.CompanyName   AS supplierName,
                    b.SubmittedDate  AS submittedDate,
                    b.GrandTotal     AS grandTotal,
                    bs.BidStatusName AS status,
                    b.ComplianceScore,
                    b.EvaluationScore,
                    b.CreatedAt
                FROM Bid b
                JOIN Tender          t  ON b.TenderID   = t.TenderID
                JOIN SupplierProfile sp ON b.SupplierID  = sp.SupplierID
                JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
                WHERE b.SupplierID = @supplierId
                ORDER BY b.SubmittedDate DESC
            `);

        const bids = bidsResult.recordset;

        if (bids.length > 0) {
            const itemsRequest = pool.request();
            const placeholders = bids.map((b, i) => {
                itemsRequest.input(`bid${i}`, sql.VarChar(50), b.bidId);
                return `@bid${i}`;
            }).join(',');

            const allItemsResult = await itemsRequest.query(`
                SELECT
                    BidID        AS bidId,
                    ItemNo       AS itemNo,
                    TenderItemID AS tenderItemId,
                    Description, Unit, Quantity, UnitPrice, Total,
                    CountryOfOrigin AS countryOfOrigin,
                    PackSize        AS packSize,
                    ExpiryDate      AS expiryDate
                FROM BidItem
                WHERE BidID IN (${placeholders})
                ORDER BY BidID, ItemNo ASC
            `);

            const itemMap = {};
            allItemsResult.recordset.forEach(row => {
                if (!itemMap[row.bidId]) itemMap[row.bidId] = [];
                itemMap[row.bidId].push({
                    itemNo:       row.itemNo,
                    tenderItemId: row.tenderItemId,
                    description:  row.Description,
                    unit:         row.Unit,
                    quantity:     row.Quantity,
                    unitPrice:    row.UnitPrice,
                    total:        row.Total,
                    countryOfOrigin: row.countryOfOrigin,
                    packSize:        row.packSize,
                    expiryDate:      row.expiryDate
                });
            });
            bids.forEach(bid => { bid.items = itemMap[bid.bidId] || []; });
        }

        res.json(bids);
    } catch (error) {
        console.error('[GET /api/bids/supplier/:supplierId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── 4. POST /api/bids  — submit a bid
router.post('/', requireAuth, async (req, res) => {
    const { bidId, tenderId, supplierId, grandTotal, submittedDate, items } = req.body;

    if (!bidId || !tenderId || !supplierId)
        return res.status(400).json({ message: 'bidId, tenderId, and supplierId are required' });

    if (supplierId !== req.user.userId)
        return res.status(403).json({ message: 'You can only submit bids for your own account' });

    try {
        const pool = await getPool();

        const tenderInfo = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT Title, TenderStatusID, ClosingDate,
                       CASE WHEN ClosingDate IS NOT NULL AND ClosingDate <= GETDATE() THEN 1 ELSE 0 END AS IsPastClosing
                FROM Tender WHERE TenderID = @tenderId
            `);

        if (tenderInfo.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        const tenderRow = tenderInfo.recordset[0];
        if (tenderRow.TenderStatusID !== 'TS002')
            return res.status(400).json({ message: 'This tender is not open for bidding' });

        if (tenderRow.IsPastClosing === 1)
            return res.status(400).json({ message: 'The closing date for this tender has passed' });
        const tenderTitle = tenderRow.Title || 'a tender';

        const supplierInfo = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT CompanyName, Email FROM SupplierProfile WHERE SupplierID = @supplierId`);

        if (supplierInfo.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier profile not found' });

        const companyName   = supplierInfo.recordset[0].CompanyName || 'A supplier';
        const supplierEmail = supplierInfo.recordset[0].Email       || null;

        const interestCheck = await pool.request()
            .input('tenderId',   sql.VarChar(50), tenderId)
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT 1 FROM Interests WHERE TenderID = @tenderId AND SupplierID = @supplierId`);

        if (interestCheck.recordset.length === 0)
            return res.status(403).json({ message: 'You must express interest in this tender before submitting a bid' });

        const existingBid = await pool.request()
            .input('tenderId',   sql.VarChar(50), tenderId)
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT BidID FROM Bid WHERE TenderID = @tenderId AND SupplierID = @supplierId`);

        if (existingBid.recordset.length > 0)
            return res.status(400).json({ message: 'You have already submitted a bid for this tender' });

        const today = new Date().toISOString().split('T')[0];

        // Expired documents do NOT block the bid. They are reported to the supplier
        // after the bid is saved so they can renew before evaluation starts.
        const expiredDocsRes = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .input('today',      sql.VarChar(10), today)
            .query(`
                SELECT JSON_VALUE(d.[value], '$.docType')    AS docType,
                       JSON_VALUE(d.[value], '$.expiryDate') AS expiryDate
                FROM SupplierProfile sp
                CROSS APPLY OPENJSON(sp.Documents) d
                WHERE sp.SupplierID = @supplierId
                  AND JSON_VALUE(d.[value], '$.requiresExpiry') = 'true'
                  AND JSON_VALUE(d.[value], '$.expiryDate')     < @today
                  AND JSON_VALUE(d.[value], '$.status')         = 'Verified'
            `);
        const expiredDocs = expiredDocsRes.recordset;

        const rejectedDocCheck = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`
                SELECT d.[value] AS doc
                FROM SupplierProfile sp
                CROSS APPLY OPENJSON(sp.Documents) d
                WHERE sp.SupplierID = @supplierId
                  AND JSON_VALUE(d.[value], '$.status') = 'Rejected'
            `);

        if (rejectedDocCheck.recordset.length > 0)
            return res.status(403).json({ message: 'You have rejected documents. Please re-upload them before submitting a bid.' });

        const pendingDocCheck = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`
                SELECT d.[value] AS doc
                FROM SupplierProfile sp
                CROSS APPLY OPENJSON(sp.Documents) d
                WHERE sp.SupplierID = @supplierId
                  AND JSON_VALUE(d.[value], '$.status') = 'Pending'
            `);

        if (pendingDocCheck.recordset.length > 0)
            return res.status(403).json({ message: 'You have documents pending verification. Please wait for admin approval before submitting a bid.' });


        if (!items || items.length === 0)
            return res.status(400).json({ message: 'At least one item is required' });

        const submittedItemIds = items.map(i => i.tenderItemId);
        const uniqueItemIds    = new Set(submittedItemIds);
        if (uniqueItemIds.size !== submittedItemIds.length)
            return res.status(400).json({ message: 'Duplicate items in bid submission' });

        const tenderItemsRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT TenderItemID, ItemNo, Quantity FROM TenderItem WHERE TenderID = @tenderId`);

        const tenderItemMap = Object.fromEntries(
            tenderItemsRes.recordset.map(ti => [ti.TenderItemID, ti])
        );

        const unknownItems = items.filter(i => !tenderItemMap[i.tenderItemId]);
        if (unknownItems.length > 0)
            return res.status(400).json({
                message: `Item(s) ${unknownItems.map(i => i.itemNo).join(', ')} do not belong to this tender`,
            });

        // Quantity is always the tender's requested quantity - client value is ignored
        const normalizedItems = items.map(i => {
            const ti = tenderItemMap[i.tenderItemId];
            return {
                tenderItemId:    i.tenderItemId,
                itemNo:          ti.ItemNo,
                description:     i.description || '',
                unit:            i.unit || '',
                quantity:        Number(ti.Quantity),
                unitPrice:       parseFloat(i.unitPrice),
                countryOfOrigin: String(i.countryOfOrigin || '').trim(),
                packSize:        String(i.packSize || '').trim(),
                expiryDate:      String(i.expiryDate || '').slice(0, 10),
            };
        });

        const invalidPrice = normalizedItems.filter(i => !(i.unitPrice > 0));
        if (invalidPrice.length > 0)
            return res.status(400).json({
                message: `Item(s) ${invalidPrice.map(i => i.itemNo).join(', ')} have an invalid unit price`,
            });

        const missingDetails = normalizedItems.filter(i => !i.countryOfOrigin || !i.packSize || !i.expiryDate);
        if (missingDetails.length > 0)
            return res.status(400).json({
                message: `Country of origin, pack size and expiry date are required for item(s): ${missingDetails.map(i => i.itemNo).join(', ')}`,
            });

        const badExpiry = normalizedItems.filter(i =>
            !/^\d{4}-\d{2}-\d{2}$/.test(i.expiryDate) ||
            isNaN(Date.parse(i.expiryDate)) ||
            i.expiryDate <= today
        );
        if (badExpiry.length > 0)
            return res.status(400).json({
                message: `Expiry date must be a valid future date for item(s): ${badExpiry.map(i => i.itemNo).join(', ')}`,
            });

        const computedGrandTotal = normalizedItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
        if (Math.abs(computedGrandTotal - parseFloat(grandTotal)) > 0.01)
            return res.status(400).json({ message: 'Grand total does not match sum of item totals' });

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            await transaction.request()
                .input('bidId',         sql.VarChar(50),    bidId)
                .input('tenderId',      sql.VarChar(50),    tenderId)
                .input('supplierId',    sql.VarChar(50),    supplierId)
                .input('submittedDate', sql.Date,           submittedDate || today)
                .input('grandTotal',    sql.Decimal(18, 2), computedGrandTotal)
                .input('bidStatusId',   sql.VarChar(20),    'BS001')
                .query(`
                    INSERT INTO Bid (BidID, TenderID, SupplierID, SubmittedDate, GrandTotal, BidStatusID, CreatedAt)
                    VALUES (@bidId, @tenderId, @supplierId, @submittedDate, @grandTotal, @bidStatusId, GETDATE())
                `);

                // Insert every item in one statement (one round trip) instead of one INSERT per item
            const itemsJson = JSON.stringify(normalizedItems.map(i => ({
                itemNo:          i.itemNo,
                description:     i.description,
                unit:            i.unit,
                quantity:        i.quantity,
                unitPrice:       i.unitPrice,
                total:           Math.round(i.quantity * i.unitPrice * 100) / 100,
                tenderItemId:    i.tenderItemId,
                countryOfOrigin: i.countryOfOrigin,
                packSize:        i.packSize,
                expiryDate:      i.expiryDate,
            })));

            await transaction.request()
                .input('bidId', sql.VarChar(50),       bidId)
                .input('items', sql.NVarChar(sql.MAX), itemsJson)
                .query(`
                    INSERT INTO BidItem
                        (BidID, ItemNo, Description, Unit, Quantity, UnitPrice, Total, CreatedAt,
                         TenderItemID, CountryOfOrigin, PackSize, ExpiryDate)
                    SELECT @bidId, j.itemNo, j.description, j.unit, j.quantity, j.unitPrice, j.total, GETDATE(),
                           j.tenderItemId, j.countryOfOrigin, j.packSize, j.expiryDate
                    FROM OPENJSON(@items) WITH (
                        itemNo          INT           '$.itemNo',
                        description     NVARCHAR(MAX) '$.description',
                        unit            NVARCHAR(50)  '$.unit',
                        quantity        DECIMAL(18,2) '$.quantity',
                        unitPrice       DECIMAL(18,2) '$.unitPrice',
                        total           DECIMAL(18,2) '$.total',
                        tenderItemId    VARCHAR(50)   '$.tenderItemId',
                        countryOfOrigin NVARCHAR(100) '$.countryOfOrigin',
                        packSize        NVARCHAR(100) '$.packSize',
                        expiryDate      DATE          '$.expiryDate'
                    ) AS j
                `);

            // Remove any existing draft for this tender/supplier
            await transaction.request()
                .input('tenderId',   sql.VarChar(50), tenderId)
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`DELETE FROM BidDraft WHERE TenderID = @tenderId AND SupplierID = @supplierId`);

            await transaction.commit();

            // ── The bid is saved from here on. Nothing below may turn this request into a failure. ──

            // Expired-document warning for the response (built now, notified in the background)
            let warning = null;
            if (expiredDocs.length > 0) {
                const count    = expiredDocs.length;
                const docNames = expiredDocs.map(d => d.docType || 'a document').join(', ');
                const closing  = tenderRow.ClosingDate
                    ? new Date(tenderRow.ClosingDate).toISOString().slice(0, 10)
                    : null;
                const message =
                    `Your bid was submitted, but ${count === 1 ? 'one of your documents has' : `${count} of your documents have`} expired (${docNames}). ` +
                    `Please renew ${count === 1 ? 'it' : 'them'} before the evaluation process starts` +
                    (closing ? ` (the tender closes on ${closing}).` : '.');

                warning = { code: 'EXPIRED_DOCUMENTS', message, documents: expiredDocs };
            }

            // Background work: not awaited, so the supplier isn't kept waiting on SMTP or notifications.
            (async () => {
                if (supplierEmail) {
                    try {
                        await sendTemplatedEmail(pool, sql, 'ETT004', supplierEmail, {
                            supplierName:  companyName,
                            tenderTitle,
                            bidId,
                            submittedDate: submittedDate || today,
                            orgName:       process.env.ORG_NAME || 'Procurement Portal',
                        });
                    } catch (mailErr) {
                        console.error('[mailer] Failed to send bid confirmation email:', mailErr.message);
                    }
                }

                try {
                    const adminIds = await getAdminUserIds(pool);
                    for (const adminUserId of adminIds) {
                        await createNotification(pool, {
                            userId:   adminUserId,
                            userType: 'admin',
                            message:  `${companyName} submitted a bid for "${tenderTitle}".`,
                            type:     'info',
                            link:     `/admin/tenders/${tenderId}`,
                        });
                    }
                } catch (notifErr) {
                    console.error('[notify] Failed to notify admins of new bid:', notifErr.message);
                }

                if (warning) {
                    try {
                        await createNotification(pool, {
                            userId:   supplierId,
                            userType: 'supplier',
                            message:  warning.message,
                            type:     'warning',
                            link:     '/supplier/documents',
                        });
                    } catch (notifErr) {
                        console.error('[notify] Failed to send expired-document notice:', notifErr.message);
                    }
                }
            })().catch(err => console.error('[post-submit] Unexpected background error:', err.message));

            try {
                await logAudit(pool, req, {
                    action: 'BID_SUBMIT', entityType: 'Bid', entityId: bidId,
                    description: `${companyName} submitted bid ${bidId} for tender "${tenderTitle}" (total ${computedGrandTotal})` +
                                (expiredDocs.length ? ` with ${expiredDocs.length} expired document(s)` : ''),
                });
            } catch (auditErr) {
                console.error('[audit] Failed to log bid submission:', auditErr.message);
            }

            res.status(201).json({
                message: 'Bid submitted successfully',
                bid:     { bidId, tenderId, supplierId, grandTotal: computedGrandTotal },
                warning,
            });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('[POST /api/bids] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── DRAFTS  /api/bids/draft/:tenderId  — supplier: autosaved work-in-progress bid
const requireSupplier = (req, res, next) =>
    req.user?.role === 'supplier'
        ? next()
        : res.status(403).json({ message: 'Only suppliers can use bid drafts' });

async function getTenderOpenState(pool, tenderId) {
    const r = await pool.request()
        .input('tenderId', sql.VarChar(50), tenderId)
        .query(`
            SELECT TenderStatusID,
                   CASE WHEN ClosingDate IS NOT NULL AND ClosingDate <= GETDATE() THEN 1 ELSE 0 END AS IsPastClosing
            FROM Tender WHERE TenderID = @tenderId
        `);
    if (r.recordset.length === 0) return { exists: false, open: false };
    const t = r.recordset[0];
    return { exists: true, open: t.TenderStatusID === 'TS002' && t.IsPastClosing === 0 };
}

router.get('/draft/:tenderId', requireAuth, requireSupplier, async (req, res) => {
    const { tenderId }  = req.params;
    const supplierId    = req.user.userId;
    try {
        const pool  = await getPool();
        const state = await getTenderOpenState(pool, tenderId);
        if (!state.exists) return res.status(404).json({ message: 'Tender not found' });
        if (!state.open)   return res.json({ draft: null });

        const bidExists = await pool.request()
            .input('tenderId',   sql.VarChar(50), tenderId)
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT 1 FROM Bid WHERE TenderID = @tenderId AND SupplierID = @supplierId`);
        if (bidExists.recordset.length > 0) return res.json({ draft: null });

        const r = await pool.request()
            .input('tenderId',   sql.VarChar(50), tenderId)
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT Payload, UpdatedAt FROM BidDraft WHERE TenderID = @tenderId AND SupplierID = @supplierId`);

        if (r.recordset.length === 0) return res.json({ draft: null });

        let entries = {};
        try { entries = JSON.parse(r.recordset[0].Payload).entries || {}; } catch { /* corrupt draft: treat as empty */ }

        res.json({ draft: { entries, updatedAt: r.recordset[0].UpdatedAt } });
    } catch (error) {
        console.error('[GET /api/bids/draft/:tenderId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

const sanitizeDraftEntries = (entries, validIds) => {
    const clean = {};
    for (const [tenderItemId, e] of Object.entries(entries)) {
        if (!validIds.has(tenderItemId) || !e || typeof e !== 'object') continue;
        const price = Number(e.unitPrice);
        clean[tenderItemId] = {
            included:        e.included !== false,
            unitPrice:       Number.isFinite(price) && price > 0 ? price : 0,
            countryOfOrigin: String(e.countryOfOrigin || '').slice(0, 100),
            packSize:        String(e.packSize || '').slice(0, 100),
            expiryDate:      /^\d{4}-\d{2}-\d{2}$/.test(String(e.expiryDate || '')) ? e.expiryDate : '',
        };
    }
    return clean;
};

// Shared checks for PUT and PATCH. Sends the error response itself and returns null if a check fails.
async function prepareDraftWrite(req, res, bodyKey) {
    const { tenderId } = req.params;
    const supplierId   = req.user.userId;
    const input        = req.body?.[bodyKey];

    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        res.status(400).json({ message: `${bodyKey} must be an object keyed by tenderItemId` });
        return null;
    }

    const pool  = await getPool();
    const state = await getTenderOpenState(pool, tenderId);
    if (!state.exists) { res.status(404).json({ message: 'Tender not found' }); return null; }
    if (!state.open)   { res.status(400).json({ message: 'This tender is no longer open for bidding' }); return null; }

    const existing = await pool.request()
        .input('tenderId',   sql.VarChar(50), tenderId)
        .input('supplierId', sql.VarChar(50), supplierId)
        .query(`SELECT 1 FROM Bid WHERE TenderID = @tenderId AND SupplierID = @supplierId`);
    if (existing.recordset.length > 0) {
        res.status(409).json({ message: 'A bid has already been submitted for this tender' });
        return null;
    }

    const itemsRes = await pool.request()
        .input('tenderId', sql.VarChar(50), tenderId)
        .query(`SELECT TenderItemID FROM TenderItem WHERE TenderID = @tenderId`);
    const validIds = new Set(itemsRes.recordset.map(r => r.TenderItemID));

    return { pool, tenderId, supplierId, clean: sanitizeDraftEntries(input, validIds) };
}

const UPSERT_DRAFT_SQL = `
    MERGE BidDraft WITH (HOLDLOCK) AS target
    USING (SELECT @supplierId AS SupplierID, @tenderId AS TenderID) AS src
       ON target.SupplierID = src.SupplierID AND target.TenderID = src.TenderID
    WHEN MATCHED THEN
        UPDATE SET Payload = @payload, UpdatedAt = GETDATE()
    WHEN NOT MATCHED THEN
        INSERT (SupplierID, TenderID, Payload, CreatedAt, UpdatedAt)
        VALUES (@supplierId, @tenderId, @payload, GETDATE(), GETDATE())
    OUTPUT inserted.UpdatedAt;
`;

async function readDraftEntries(pool, tenderId, supplierId) {
    const r = await pool.request()
        .input('tenderId',   sql.VarChar(50), tenderId)
        .input('supplierId', sql.VarChar(50), supplierId)
        .query(`SELECT Payload FROM BidDraft WHERE TenderID = @tenderId AND SupplierID = @supplierId`);
    if (r.recordset.length === 0) return {};
    try { return JSON.parse(r.recordset[0].Payload).entries || {}; } catch { return {}; }
}

// Same locking pattern as the PATCH route, reusable
async function mergeDraftEntries(pool, tenderId, supplierId, clean) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
        const cur = await tx.request()
            .input('tenderId',   sql.VarChar(50), tenderId)
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`
                SELECT Payload FROM BidDraft WITH (UPDLOCK, HOLDLOCK)
                WHERE TenderID = @tenderId AND SupplierID = @supplierId
            `);
        let entries = {};
        if (cur.recordset.length > 0) {
            try { entries = JSON.parse(cur.recordset[0].Payload).entries || {}; } catch { /* start fresh */ }
        }
        Object.assign(entries, clean);

        const result = await tx.request()
            .input('tenderId',   sql.VarChar(50),       tenderId)
            .input('supplierId', sql.VarChar(50),       supplierId)
            .input('payload',    sql.NVarChar(sql.MAX), JSON.stringify({ entries }))
            .query(UPSERT_DRAFT_SQL);

        await tx.commit();
        return result.recordset[0].UpdatedAt;
    } catch (err) {
        await tx.rollback();
        throw err;
    }
}

// GET /api/bids/template/:tenderId  — download the Excel template, pre-filled from the supplier's draft
router.get('/template/:tenderId', requireAuth, requireSupplier, async (req, res) => {
    const { tenderId } = req.params;
    try {
        const pool = await getPool();

        const t = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT TenderID, Title, ClosingDate, TenderStatusID,
                       CASE WHEN ClosingDate IS NOT NULL AND ClosingDate <= GETDATE() THEN 1 ELSE 0 END AS IsPastClosing
                FROM Tender WHERE TenderID = @tenderId
            `);
        if (t.recordset.length === 0) return res.status(404).json({ message: 'Tender not found' });
        const tr = t.recordset[0];
        if (tr.TenderStatusID !== 'TS002' || tr.IsPastClosing === 1)
            return res.status(400).json({ message: 'This tender is not open for bidding' });

        const itemsRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT TenderItemID, ItemNo, Description, Unit, Quantity
                FROM TenderItem WHERE TenderID = @tenderId ORDER BY ItemNo ASC
            `);

        const entries = await readDraftEntries(pool, tenderId, req.user.userId);

        const wb = await buildBidTemplate({
            tender:  { id: tr.TenderID, title: tr.Title, closingDate: tr.ClosingDate ? new Date(tr.ClosingDate).toISOString() : '' },
            items:   itemsRes.recordset.map(r => ({
                tenderItemId: r.TenderItemID, itemNo: r.ItemNo,
                description:  r.Description,  unit: r.Unit, quantity: r.Quantity,
            })),
            entries,
            org: process.env.ORG_NAME || 'Procurement Portal',
        });

        const buf = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Bid_Template_${tenderId}.xlsx"`);
        res.send(buf);
    } catch (error) {
        console.error('[GET /api/bids/template/:tenderId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST /api/bids/draft/:tenderId/import  — merge an uploaded template into the supplier's draft
router.post('/draft/:tenderId/import', requireAuth, requireSupplier,
    (req, res, next) => bidXlsxUpload.single('file')(req, res, (err) => {
        if (!err) return next();
        res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (maximum 5 MB).' : err.message });
    }),
    async (req, res) => {
        const { tenderId } = req.params;
        const supplierId   = req.user.userId;
        try {
            if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
            if (!/\.xlsx$/i.test(req.file.originalname || ''))
                return res.status(400).json({ message: 'Please upload an .xlsx file (save it as "Excel Workbook").' });

            const pool  = await getPool();
            const state = await getTenderOpenState(pool, tenderId);
            if (!state.exists) return res.status(404).json({ message: 'Tender not found' });
            if (!state.open)   return res.status(400).json({ message: 'This tender is no longer open for bidding' });

            const existing = await pool.request()
                .input('tenderId',   sql.VarChar(50), tenderId)
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`SELECT 1 FROM Bid WHERE TenderID = @tenderId AND SupplierID = @supplierId`);
            if (existing.recordset.length > 0)
                return res.status(409).json({ message: 'A bid has already been submitted for this tender' });

            const itemsRes = await pool.request()
                .input('tenderId', sql.VarChar(50), tenderId)
                .query(`SELECT TenderItemID, ItemNo FROM TenderItem WHERE TenderID = @tenderId`);
            const items   = itemsRes.recordset.map(r => ({ tenderItemId: r.TenderItemID, itemNo: r.ItemNo }));
            const current = await readDraftEntries(pool, tenderId, supplierId);

            const parsed = await parseBidTemplate(req.file.buffer, { tenderId, items, current });
            const clean  = sanitizeDraftEntries(parsed.entries, new Set(items.map(i => i.tenderItemId)));

            let updatedAt = null;
            if (Object.keys(clean).length > 0)
                updatedAt = await mergeDraftEntries(pool, tenderId, supplierId, clean);

            res.json({
                message:      'Import complete',
                imported:     Object.keys(clean).length,
                unchanged:    parsed.skipped,
                problemCount: parsed.problems.length,
                problems:     parsed.problems.slice(0, 100),
                updatedAt,
            });
        } catch (error) {
            if (error instanceof ImportError) return res.status(400).json({ message: error.message });
            console.error('[POST /api/bids/draft/:tenderId/import] Error:', error);
            res.status(500).json({ message: error.message });
        }
    }
);

// PUT: replace the whole draft (used later by the Excel import)
router.put('/draft/:tenderId', requireAuth, requireSupplier, async (req, res) => {
    try {
        const ctx = await prepareDraftWrite(req, res, 'entries');
        if (!ctx) return;

        const result = await ctx.pool.request()
            .input('tenderId',   sql.VarChar(50),       ctx.tenderId)
            .input('supplierId', sql.VarChar(50),       ctx.supplierId)
            .input('payload',    sql.NVarChar(sql.MAX), JSON.stringify({ entries: ctx.clean }))
            .query(UPSERT_DRAFT_SQL);

        res.json({ message: 'Draft saved', updatedAt: result.recordset[0].UpdatedAt });
    } catch (error) {
        console.error('[PUT /api/bids/draft/:tenderId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// PATCH: merge only the changed items into the stored draft (used by autosave)
router.patch('/draft/:tenderId', requireAuth, requireSupplier, async (req, res) => {
    try {
        const ctx = await prepareDraftWrite(req, res, 'changes');
        if (!ctx) return;
        const { pool, tenderId, supplierId, clean } = ctx;

        const tx = new sql.Transaction(pool);
        await tx.begin();
        try {
            const cur = await tx.request()
                .input('tenderId',   sql.VarChar(50), tenderId)
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`
                    SELECT Payload FROM BidDraft WITH (UPDLOCK, HOLDLOCK)
                    WHERE TenderID = @tenderId AND SupplierID = @supplierId
                `);

            let entries = {};
            if (cur.recordset.length > 0) {
                try { entries = JSON.parse(cur.recordset[0].Payload).entries || {}; } catch { /* corrupt: start fresh */ }
            }
            Object.assign(entries, clean);

            const result = await tx.request()
                .input('tenderId',   sql.VarChar(50),       tenderId)
                .input('supplierId', sql.VarChar(50),       supplierId)
                .input('payload',    sql.NVarChar(sql.MAX), JSON.stringify({ entries }))
                .query(UPSERT_DRAFT_SQL);

            await tx.commit();
            res.json({ message: 'Draft saved', updatedAt: result.recordset[0].UpdatedAt });
        } catch (err) {
            await tx.rollback();
            throw err;
        }
    } catch (error) {
        console.error('[PATCH /api/bids/draft/:tenderId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

router.delete('/draft/:tenderId', requireAuth, requireSupplier, async (req, res) => {
    try {
        const pool = await getPool();
        await pool.request()
            .input('tenderId',   sql.VarChar(50), req.params.tenderId)
            .input('supplierId', sql.VarChar(50), req.user.userId)
            .query(`DELETE FROM BidDraft WHERE TenderID = @tenderId AND SupplierID = @supplierId`);
        res.json({ message: 'Draft discarded' });
    } catch (error) {
        console.error('[DELETE /api/bids/draft/:tenderId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── 5. PATCH /api/bids/:id/status  — admin: award / reject
router.patch('/:id/status', requireAdmin, async (req, res) => {
    const { id }           = req.params;
    const { status, note } = req.body;

    const bidStatusMap = { Awarded: 'BS002', Rejected: 'BS003' };
    const bidStatusId  = bidStatusMap[status];
    if (!bidStatusId)
        return res.status(400).json({ message: 'Invalid status. Must be Awarded or Rejected.' });

    try {
        const pool      = await getPool();
        const bidResult = await pool.request()
            .input('bidId', sql.VarChar(50), id)
            .query(`
                SELECT b.BidID, b.TenderID, b.SupplierID, b.GrandTotal,
                       t.Title AS tenderTitle,
                       sp.CompanyName AS supplierName, sp.Email AS supplierEmail,
                       bs.BidStatusName AS CurrentStatus
                FROM Bid b
                JOIN Tender          t  ON b.TenderID   = t.TenderID
                JOIN SupplierProfile sp ON b.SupplierID  = sp.SupplierID
                JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
                WHERE b.BidID = @bidId
            `);

        if (bidResult.recordset.length === 0)
            return res.status(404).json({ message: 'Bid not found' });

        const bid = bidResult.recordset[0];

        if (bid.CurrentStatus === 'Awarded')
            return res.status(400).json({ message: 'Cannot modify a bid that has already been awarded.' });
        if (bid.CurrentStatus === 'Rejected')
            return res.status(400).json({ message: 'Cannot modify a bid that has already been rejected.' });

        // ── Award gate — run all five eligibility checks ──────────────────────
        if (status === 'Awarded') {
            const eligibility = await checkAwardEligibility(pool, sql, bid.TenderID);
            if (!eligibility.eligible)
                return res.status(400).json({ message: eligibility.reason });

            // Additional check: the supplier being awarded must be responsive
            if (!eligibility.responsiveSupplierIds.includes(bid.SupplierID))
                return res.status(400).json({
                    message: 'This supplier was found non-responsive during evaluation and cannot be awarded.',
                });

            // Load tender items and winning bid items for bulk award
            const tenderItemsResult = await pool.request()
                .input('tenderId', sql.VarChar(50), bid.TenderID)
                .query(`
                    SELECT TenderItemID, ItemNo, Description, Unit, Quantity, EstimatedUnitPrice
                    FROM TenderItem
                    WHERE TenderID = @tenderId
                    ORDER BY ItemNo ASC
                `);

            if (tenderItemsResult.recordset.length === 0)
                return res.status(400).json({ message: 'This tender has no items to award.' });

            const bidItemsResult = await pool.request()
                .input('bidId', sql.VarChar(50), id)
                .query(`
                    SELECT ItemNo, TenderItemID, Quantity, UnitPrice, Total
                    FROM BidItem
                    WHERE BidID = @bidId
                `);

            const bidItemMap = {};
            bidItemsResult.recordset.forEach(bi => { bidItemMap[bi.ItemNo] = bi; });

            const transaction = new sql.Transaction(pool);
            await transaction.begin();

            try {
                // Award the winning bid
                await transaction.request()
                    .input('bidId',       sql.VarChar(50), id)
                    .input('bidStatusId', sql.VarChar(20), bidStatusId)
                    .query(`UPDATE Bid SET BidStatusID = @bidStatusId WHERE BidID = @bidId`);

                // Clear any existing awards then bulk-insert one row per item
                await transaction.request()
                    .input('tenderId', sql.VarChar(50), bid.TenderID)
                    .query(`DELETE FROM TenderItemAward WHERE TenderID = @tenderId`);

                for (const tenderItem of tenderItemsResult.recordset) {
                    const bidItem   = bidItemMap[tenderItem.ItemNo];
                    const qty       = bidItem ? Number(bidItem.Quantity)  : Number(tenderItem.Quantity);
                    const unitPrice = bidItem ? Number(bidItem.UnitPrice) : Number(tenderItem.EstimatedUnitPrice);
                    const total     = bidItem ? Number(bidItem.Total)     : qty * unitPrice;

                    await transaction.request()
                        .input('awardId',          sql.VarChar(50),       generateId('AWARD'))
                        .input('tenderItemId',     sql.VarChar(50),       tenderItem.TenderItemID)
                        .input('tenderId',         sql.VarChar(50),       bid.TenderID)
                        .input('bidId',            sql.VarChar(50),       id)
                        .input('supplierId',       sql.VarChar(50),       bid.SupplierID)
                        .input('awardedQuantity',  sql.Decimal(18, 2),    qty)
                        .input('awardedUnitPrice', sql.Decimal(18, 2),    unitPrice)
                        .input('awardedTotal',     sql.Decimal(18, 2),    total)
                        .input('awardNote',        sql.NVarChar(sql.MAX), note || null)
                        .query(`
                            INSERT INTO TenderItemAward (
                                AwardID, TenderItemID, TenderID, BidID, SupplierID,
                                AwardedQuantity, AwardedUnitPrice, AwardedTotal, AwardDate, AwardNote
                            ) VALUES (
                                @awardId, @tenderItemId, @tenderId, @bidId, @supplierId,
                                @awardedQuantity, @awardedUnitPrice, @awardedTotal, GETDATE(), @awardNote
                            )
                        `);
                }

                // Flip tender to Awarded
                await transaction.request()
                    .input('tenderId', sql.VarChar(50), bid.TenderID)
                    .query(`
                        UPDATE Tender SET TenderStatusID = 'TS004', UpdatedAt = GETDATE()
                        WHERE TenderID = @tenderId
                    `);

                // Auto-reject all other submitted bids
                await transaction.request()
                    .input('tenderId',   sql.VarChar(50), bid.TenderID)
                    .input('winningBid', sql.VarChar(50), id)
                    .query(`
                        UPDATE Bid SET
                            BidStatusID     = 'BS003',
                            RejectionReason = 'Tender awarded to another supplier',
                            RejectedAt      = GETDATE()
                        WHERE TenderID   = @tenderId
                          AND BidID     <> @winningBid
                          AND BidStatusID = 'BS001'
                    `);

                await transaction.commit();

                // Notify auto-rejected suppliers
                try {
                    const losingBidsResult = await pool.request()
                        .input('tenderId',   sql.VarChar(50), bid.TenderID)
                        .input('winningBid', sql.VarChar(50), id)
                        .query(`
                            SELECT b.SupplierID
                            FROM Bid b
                            WHERE b.TenderID   = @tenderId
                            AND b.BidID     <> @winningBid
                            AND b.BidStatusID = 'BS003'
                            AND b.RejectionReason = 'Tender awarded to another supplier'
                        `);

                    for (const losingBid of losingBidsResult.recordset) {
                        const losingUserId = await getSupplierUserId(pool, losingBid.SupplierID);
                        if (losingUserId) {
                            await createNotification(pool, {
                                userId:   losingUserId,
                                userType: 'supplier',
                                message:  `Your bid for "${bid.tenderTitle}" was not successful. The tender has been awarded to another supplier.`,
                                type:     'error',
                                link:     '/supplier/bids',
                            });
                        }
                    }
                } catch (notifErr) {
                    console.error('[notify] Failed to notify auto-rejected suppliers:', notifErr.message);
                }
            } catch (err) {
                await transaction.rollback();
                throw err;
            }

        } else {
            // Rejection — simple status update
            await pool.request()
                .input('bidId',           sql.VarChar(50),       id)
                .input('bidStatusId',     sql.VarChar(20),       bidStatusId)
                .input('rejectionReason', sql.NVarChar(sql.MAX), note || null)
                .input('rejectedAt',      sql.DateTime,          new Date())
                .query(`
                    UPDATE Bid SET
                        BidStatusID     = @bidStatusId,
                        RejectionReason = @rejectionReason,
                        RejectedAt      = @rejectedAt
                    WHERE BidID = @bidId
                `);
        }

        // Notify the supplier
        const supplierUserId = await getSupplierUserId(pool, bid.SupplierID);
        if (supplierUserId) {
            await createNotification(pool, {
                userId:   supplierUserId,
                userType: 'supplier',
                message:  status === 'Awarded'
                    ? `Congratulations! Your bid for "${bid.tenderTitle}" has been awarded.`
                    : `Your bid for "${bid.tenderTitle}" was not successful.${note ? ` Reason: ${note}` : ''}`,
                type:    status === 'Awarded' ? 'success' : 'error',
                link:    '/supplier/bids',
            });
        }

        // Send award email
        if (status === 'Awarded') {
            try {
                if (bid.supplierEmail) {
                    await sendTemplatedEmail(pool, sql, 'ETT005', bid.supplierEmail, {
                        supplierName: bid.supplierName,
                        tenderTitle:  bid.tenderTitle,
                        orgName:      process.env.ORG_NAME || 'Procurement Portal',
                    });
                }
            } catch (mailErr) {
                console.error('[mailer] Failed to send award email:', mailErr.message);
            }
        }

        await logAudit(pool, req, {
            action: status === 'Awarded' ? 'BID_AWARD' : 'BID_REJECT',
            entityType: 'Bid', entityId: id,
            description: status === 'Awarded'
                ? `Bulk-awarded whole tender "${bid.tenderTitle}" to ${bid.supplierName} via bid ${id} (amount ${bid.GrandTotal})`
                : `Rejected bid ${id} from ${bid.supplierName} for "${bid.tenderTitle}"${note ? ` — reason: ${note}` : ''}`,
        });

        res.json({
            message: `Bid ${status.toLowerCase()} successfully`,
            bid:     { id, status, rejectionReason: status === 'Rejected' ? (note || null) : null },
        });

    } catch (error) {
        console.error('[PATCH /api/bids/:id/status] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── 6. GET /api/bids/:bidId/download  - PDF receipt
router.get('/:bidId/download', requireAuth, async (req, res) => {
    const { bidId }        = req.params;
    const { userId, role } = req.user;

    try {
        const pool = await getPool();

        let query = `
            SELECT
                b.BidID, b.SubmittedDate, b.GrandTotal,
                bs.BidStatusName AS Status,
                t.TenderID, t.Title, t.Description AS TenderDescription,
                t.ClosingDate, t.EstimatedBudget,
                t.CategoryID, tc.TenderCategoryName AS CategoryName,
                sp.CompanyName, sp.RegistrationNumber, sp.ContactPerson,
                sp.Email, sp.Phone, sp.Address
            FROM Bid b
            JOIN Tender          t  ON b.TenderID   = t.TenderID
            JOIN TenderCategory  tc ON t.CategoryID = tc.TenderCategoryID
            JOIN SupplierProfile sp ON b.SupplierID  = sp.SupplierID
            JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
            WHERE b.BidID = @bidId
        `;
        if (role === 'supplier') query += ` AND b.SupplierID = @supplierId`;

        const result = await pool.request()
            .input('bidId',      sql.VarChar(50), bidId)
            .input('supplierId', sql.VarChar(50), role === 'supplier' ? userId : null)
            .query(query);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Bid not found or access denied' });

        const bid         = result.recordset[0];
        const itemsResult = await pool.request()
            .input('bidId', sql.VarChar(50), bidId)
            .query(`
                SELECT ItemNo, TenderItemID, Description, Unit, Quantity, UnitPrice, Total,
                       CountryOfOrigin, PackSize, ExpiryDate
                FROM BidItem
                WHERE BidID = @bidId
                ORDER BY ItemNo ASC
            `);
        const items = itemsResult.recordset;

        // ── Helpers ───────────────────────────────────────────────────────────
        const fmtDate = (d) => {
            if (!d) return '-';
            const dt = new Date(d);
            return isNaN(dt.getTime()) ? '-' : dt.toISOString().slice(0, 10);
        };
        const money = (n) =>
            'GHS ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const val = (v) => (v === null || v === undefined || String(v).trim() === '') ? '-' : String(v);

        const ORG = process.env.ORG_NAME || 'Procurement Portal';
        const C = {
            accent: '#C2571A',
            dark:   '#1F2937',
            mid:    '#6B7280',
            line:   '#D1D5DB',
        };
        const L = 50, R = 545, W = 495;
        const PAGE_LIMIT = 765;

        const hline = (x1, x2, y, width, color) => {
            doc.moveTo(x1, y).lineTo(x2, y).lineWidth(width).strokeColor(color).stroke();
            doc.lineWidth(1);
        };

        const doc = new PDFDocument({
            margin: 50,
            size: 'A4',
            bufferPages: true,
            info: { Title: `Bid Receipt ${bid.BidID}`, Author: ORG },
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Bid_${bidId}_Receipt.pdf"`);
        doc.pipe(res);

        // ── Header ────────────────────────────────────────────────────────────
        const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
        let logoOk = false;
        if (fs.existsSync(logoPath)) {
            try {
                doc.image(logoPath, L, 36, { fit: [190, 78] });
                logoOk = true;
            } catch (logoErr) {
                console.error('[Download Bid PDF] Logo failed to load:', logoErr.message);
            }
        }
        if (!logoOk) {
            doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(16)
               .text(ORG, L, 60, { lineBreak: false });
        }

        doc.fillColor(C.mid).font('Helvetica').fontSize(8.5)
           .text(ORG.toUpperCase(), 250, 48, { width: 295, align: 'right', characterSpacing: 1, lineBreak: false });
        doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(18)
           .text('Bid Confirmation Receipt', 250, 62, { width: 295, align: 'right', lineBreak: false });
        doc.fillColor(C.mid).font('Helvetica').fontSize(8.5)
           .text(`Generated ${new Date().toLocaleString('en-GB')}`, 250, 88, { width: 295, align: 'right', lineBreak: false });

        hline(L, R, 128, 1.5, C.accent);

        // ── Reference row ─────────────────────────────────────────────────────
        const metaY = 148;
        const statusColors = { Awarded: '#15803D', Rejected: '#B91C1C' };
        const statusColor  = statusColors[bid.Status] || '#B45309';

        const metaLabel = (text, x) =>
            doc.fillColor(C.mid).font('Helvetica-Bold').fontSize(7.5)
               .text(text, x, metaY, { characterSpacing: 0.8, lineBreak: false });
        const metaValue = (text, x, color) =>
            doc.fillColor(color || C.dark).font('Helvetica-Bold').fontSize(11)
               .text(text, x, metaY + 13, { lineBreak: false });

        metaLabel('BID REFERENCE', 50);  metaValue(val(bid.BidID), 50);
        metaLabel('SUBMITTED',    230);  metaValue(fmtDate(bid.SubmittedDate), 230);
        metaLabel('STATUS',       400);  metaValue(val(bid.Status), 400, statusColor);

        hline(L, R, 190, 0.5, C.line);

        // ── Tender and supplier details ───────────────────────────────────────
        const drawKV = (x, y, title, fields) => {
            doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(8.5)
               .text(title, x, y, { characterSpacing: 1, lineBreak: false });
            hline(x, x + 235, y + 16, 0.75, C.dark);

            let cy = y + 26;
            fields.forEach(([label, value]) => {
                doc.font('Helvetica').fontSize(9);
                const h = Math.max(12, doc.heightOfString(value, { width: 155 }));
                doc.fillColor(C.mid).font('Helvetica').fontSize(8.5)
                   .text(label, x, cy + 0.5, { width: 76, lineBreak: false });
                doc.fillColor(C.dark).font('Helvetica').fontSize(9)
                   .text(value, x + 80, cy, { width: 155 });
                cy += h + 8;
            });
            return cy;
        };

        const detailY = 208;
        const tenderEnd = drawKV(L, detailY, 'TENDER', [
            ['Tender ID',    val(bid.TenderID)],
            ['Title',        val(bid.Title)],
            ['Category',     val(bid.CategoryName)],
            ['Closing date', fmtDate(bid.ClosingDate)],
            ['Est. budget',  money(bid.EstimatedBudget)],
        ]);
        const supplierEnd = drawKV(310, detailY, 'SUPPLIER', [
            ['Company',     val(bid.CompanyName)],
            ['Reg. number', val(bid.RegistrationNumber)],
            ['Contact',     val(bid.ContactPerson)],
            ['Email',       val(bid.Email)],
            ['Phone',       val(bid.Phone)],
            ['Address',     val(bid.Address)],
        ]);
        const detailEnd = Math.max(tenderEnd, supplierEnd);

        // ── Items table ───────────────────────────────────────────────────────
        const itemsY = detailEnd + 22;
        doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(8.5)
           .text('BID ITEMS', L, itemsY, { characterSpacing: 1, lineBreak: false });

        const cols      = [50, 76, 276, 322, 368, 458];
        const colWidths = [26, 200, 46, 46, 90, 87];
        const cell = (i, text, y, align) =>
            doc.text(text, cols[i], y, {
                width: colWidths[i] - (i === 5 ? 0 : 8),
                align: align || 'left',
                lineBreak: false,
            });

        const drawTableHeader = (y) => {
            doc.fillColor(C.mid).font('Helvetica-Bold').fontSize(7.5);
            cell(0, '#',          y + 4);
            cell(1, 'DESCRIPTION', y + 4);
            cell(2, 'UNIT',       y + 4);
            cell(3, 'QTY',        y + 4, 'right');
            cell(4, 'UNIT PRICE', y + 4, 'right');
            cell(5, 'TOTAL',      y + 4, 'right');
            hline(L, R, y + 18, 1, C.dark);
            return y + 18;
        };

        let curY = drawTableHeader(itemsY + 20);

        items.forEach((item) => {
            const description = val(item.Description);
            doc.font('Helvetica').fontSize(9);
            const descHeight = doc.heightOfString(description, { width: colWidths[1] - 8 });
            const mainHeight = Math.max(12, descHeight);
            const rowHeight  = 8 + mainHeight + 3 + 10 + 8;

            if (curY + rowHeight > PAGE_LIMIT) {
                doc.addPage();
                curY = drawTableHeader(50);
            }

            const ty = curY + 8;
            doc.fillColor(C.mid).font('Helvetica').fontSize(9);
            cell(0, String(item.ItemNo), ty);

            doc.fillColor(C.dark).font('Helvetica').fontSize(9);
            doc.text(description, cols[1], ty, { width: colWidths[1] - 8 });
            cell(2, val(item.Unit), ty);
            cell(3, Number(item.Quantity).toLocaleString('en-US'), ty, 'right');
            cell(4, money(item.UnitPrice), ty, 'right');
            doc.font('Helvetica-Bold');
            cell(5, money(item.Total), ty, 'right');

            doc.fillColor(C.mid).font('Helvetica').fontSize(7.5).text(
                `Origin: ${val(item.CountryOfOrigin)}   |   Pack size: ${val(item.PackSize)}   |   Expiry: ${fmtDate(item.ExpiryDate)}`,
                cols[1], ty + mainHeight + 3,
                { width: 400, lineBreak: false }
            );

            hline(L, R, curY + rowHeight, 0.5, C.line);
            curY += rowHeight;
        });

        // ── Totals ────────────────────────────────────────────────────────────
        if (curY + 80 > PAGE_LIMIT) {
            doc.addPage();
            curY = 50;
        }
        curY += 16;

        doc.fillColor(C.mid).font('Helvetica').fontSize(9)
           .text('Items bid', 330, curY, { width: 100, lineBreak: false });
        doc.fillColor(C.dark).font('Helvetica').fontSize(9)
           .text(String(items.length), 330, curY, { width: 215, align: 'right', lineBreak: false });

        hline(330, R, curY + 20, 1.5, C.accent);

        doc.fillColor(C.dark).font('Helvetica-Bold').fontSize(10)
           .text('Grand total', 330, curY + 31, { width: 100, lineBreak: false });
        doc.fontSize(15)
           .text(money(bid.GrandTotal), 330, curY + 28, { width: 215, align: 'right', lineBreak: false });

        // ── Footer on every page ──────────────────────────────────────────────
        const range = doc.bufferedPageRange();
        for (let i = range.start; i < range.start + range.count; i++) {
            doc.switchToPage(i);
            doc.page.margins.bottom = 0;

            hline(L, R, 792, 0.5, C.line);
            doc.fillColor(C.mid).font('Helvetica').fontSize(7.5);
            doc.text(`${ORG}   |   System-generated receipt. Please retain for your records.`, L, 802, { width: 380, lineBreak: false });
            doc.text(`Page ${i - range.start + 1} of ${range.count}`, 445, 802, { width: 100, align: 'right', lineBreak: false });
        }

        doc.end();

    } catch (error) {
        console.error('[Download Bid PDF] Error:', error);
        if (!res.headersSent) res.status(500).json({ message: error.message });
        else res.end();
    }
});

// ── 7. GET /api/bids/:bidId  — single bid with items
router.get('/:bidId', requireAuth, async (req, res) => {
    const { bidId }        = req.params;
    const { userId, role } = req.user;

    try {
        const pool           = await getPool();
        const userSupplierId = role === 'supplier' ? userId : null;

        let query = `
            SELECT
                b.BidID          AS bidId,
                b.TenderID       AS tenderId,
                t.Title          AS tenderTitle,
                b.SupplierID     AS supplierId,
                sp.CompanyName   AS supplierName,
                b.SubmittedDate  AS submittedDate,
                b.GrandTotal     AS grandTotal,
                bs.BidStatusName AS status,
                b.ComplianceScore,
                b.EvaluationScore,
                b.CreatedAt
            FROM Bid b
            JOIN Tender          t  ON b.TenderID   = t.TenderID
            JOIN SupplierProfile sp ON b.SupplierID  = sp.SupplierID
            JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
            WHERE b.BidID = @bidId
        `;
        if (role === 'supplier') query += ` AND b.SupplierID = @supplierId`;

        const result = await pool.request()
            .input('bidId',      sql.VarChar(50), bidId)
            .input('supplierId', sql.VarChar(50), userSupplierId)
            .query(query);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Bid not found or access denied' });

        const bid         = result.recordset[0];
        const itemsResult = await pool.request()
        .input('bidId', sql.VarChar(50), bidId)
        .query(`
            SELECT
                ItemNo          AS itemNo,
                TenderItemID    AS tenderItemId,
                Description     AS description,
                Unit            AS unit,
                Quantity        AS quantity,
                UnitPrice       AS unitPrice,
                Total           AS total,
                CountryOfOrigin AS countryOfOrigin,
                PackSize        AS packSize,
                ExpiryDate      AS expiryDate
            FROM BidItem
            WHERE BidID = @bidId
            ORDER BY ItemNo ASC
            `);
            
        bid.items = itemsResult.recordset;
        res.json(bid);

    } catch (error) {
        console.error('[GET /api/bids/:bidId] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;