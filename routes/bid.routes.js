'use strict';

const express    = require('express');
const router     = express.Router();

const { requireAuth, requireAdmin }   = require('../middleware/auth');
const { getPool, sql }                = require('../db/procurement');
const { createNotification, getAdminUserIds, getSupplierUserId } = require('../helpers/notifications');
const { generateId }                  = require('../utils/idGenerator');
const { logAudit }                    = require('../helpers/audit');
const { sendTemplatedEmail }          = require('../helpers/mailers');
const { checkAwardEligibility }       = require('../helpers/evaluationHelpers');

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE ORDER (important — Express matches top-to-bottom):
//   1. GET  /                          admin: all bids
//   2. GET  /tender/:tenderId          admin: bids for a tender
//   3. GET  /supplier/:supplierId      supplier: their own bids
//   4. POST /                          submit a bid
//   5. PATCH /:id/status               admin: award / reject
//   6. GET  /:bidId/download           PDF receipt   ← MUST be before /:bidId
//   7. GET  /:bidId                    single bid    ← wildcard, always last
// ─────────────────────────────────────────────────────────────────────────────


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
                Description, Unit, Quantity, UnitPrice, Total
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
                    Description, Unit, Quantity, UnitPrice, Total
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
                    Description, Unit, Quantity, UnitPrice, Total
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
            .query(`SELECT Title, TenderStatusID FROM Tender WHERE TenderID = @tenderId`);

        if (tenderInfo.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        const tenderRow = tenderInfo.recordset[0];
        if (tenderRow.TenderStatusID !== 'TS002')
            return res.status(400).json({ message: 'This tender is not open for bidding' });

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
        const complianceCheck = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .input('today',      sql.VarChar(10), today)
            .query(`
                SELECT d.[value] AS doc
                FROM SupplierProfile sp
                CROSS APPLY OPENJSON(sp.Documents) d
                WHERE sp.SupplierID = @supplierId
                  AND JSON_VALUE(d.[value], '$.requiresExpiry') = 'true'
                  AND JSON_VALUE(d.[value], '$.expiryDate')     < @today
                  AND JSON_VALUE(d.[value], '$.status')         = 'Verified'
            `);

        if (complianceCheck.recordset.length > 0)
            return res.status(403).json({ message: 'You have expired documents. Please renew them before submitting a bid.' });

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

        const invalidItems = items.filter(i => i.quantity <= 0 || i.unitPrice <= 0);
        if (invalidItems.length > 0)
            return res.status(400).json({
                message: `Item(s) ${invalidItems.map(i => i.itemNo).join(', ')} have invalid quantity or unit price`,
            });

        const overQuantityItems = items.filter(i => {
            const tenderItem = tenderItemMap[i.tenderItemId];
            return i.quantity > tenderItem.Quantity;
        });
        if (overQuantityItems.length > 0)
            return res.status(400).json({
                message: `Bid quantity exceeds requested quantity for item(s): ${overQuantityItems.map(i => i.itemNo).join(', ')}`,
            });

        const computedGrandTotal = items.reduce((sum, i) => sum + (parseFloat(i.quantity) * parseFloat(i.unitPrice)), 0);
        if (Math.abs(computedGrandTotal - grandTotal) > 0.01)
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

            for (const item of items) {
                const itemTotal = parseFloat(item.quantity) * parseFloat(item.unitPrice);
                await transaction.request()
                    .input('bidId',        sql.VarChar(50),       bidId)
                    .input('itemNo',       sql.Int,               item.itemNo)
                    .input('description',  sql.NVarChar(sql.MAX), item.description  || '')
                    .input('unit',         sql.NVarChar(50),      item.unit         || '')
                    .input('quantity',     sql.Decimal(18, 2),    item.quantity)
                    .input('unitPrice',    sql.Decimal(18, 2),    item.unitPrice)
                    .input('total',        sql.Decimal(18, 2),    itemTotal)
                    .input('tenderItemId', sql.VarChar(50),       item.tenderItemId)
                    .query(`
                        INSERT INTO BidItem
                            (BidID, ItemNo, Description, Unit, Quantity, UnitPrice, Total, CreatedAt, TenderItemID)
                        VALUES
                            (@bidId, @itemNo, @description, @unit, @quantity, @unitPrice, @total, GETDATE(), @tenderItemId)
                    `);
            }

            await transaction.commit();

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

            try {
                if (supplierEmail) {
                    await sendTemplatedEmail(pool, sql, 'ETT004', supplierEmail, {
                        supplierName:  companyName,
                        tenderTitle,
                        bidId,
                        submittedDate: submittedDate || today,
                        orgName:       process.env.ORG_NAME || 'Procurement Portal',
                    });
                }
            } catch (mailErr) {
                console.error('[mailer] Failed to send bid confirmation email:', mailErr.message);
            }

            await logAudit(pool, req, {
                action: 'BID_SUBMIT', entityType: 'Bid', entityId: bidId,
                description: `${companyName} submitted bid ${bidId} for tender "${tenderTitle}" (total ${computedGrandTotal})`,
            });

            res.status(201).json({
                message: 'Bid submitted successfully',
                bid:     { bidId, tenderId, supplierId, grandTotal: computedGrandTotal },
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
                userId:  supplierUserId,
                message: status === 'Awarded'
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


// ── 6. GET /api/bids/:bidId/download  — PDF receipt
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
                SELECT ItemNo, TenderItemID, Description, Unit, Quantity, UnitPrice, Total
                FROM BidItem WHERE BidID = @bidId ORDER BY ItemNo ASC
            `);
        const items = itemsResult.recordset;

        const PDFDocument = require('pdfkit');
        const doc         = new PDFDocument({ margin: 50, size: 'A4' });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="Bid_${bidId}_Receipt.pdf"`);
        doc.pipe(res);

        doc.fontSize(20).font('Helvetica-Bold').text('BID CONFIRMATION RECEIPT', { align: 'center' });
        doc.moveDown();
        doc.fontSize(10).font('Helvetica').text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
        doc.moveDown(2);

        doc.rect(50, doc.y, 495, 60).stroke();
        doc.fontSize(10).font('Helvetica-Bold').text('BID REFERENCE:', 60, doc.y + 10);
        doc.font('Helvetica').text(bid.BidID, 60, doc.y + 25);
        doc.font('Helvetica-Bold').text('SUBMITTED DATE:', 300, doc.y + 10);
        doc.font('Helvetica').text(new Date(bid.SubmittedDate).toLocaleString(), 300, doc.y + 25);
        doc.font('Helvetica-Bold').text('STATUS:', 60, doc.y + 40);
        const statusColor = bid.Status === 'Awarded' ? 'green' : (bid.Status === 'Rejected' ? 'red' : 'orange');
        doc.fillColor(statusColor).text(bid.Status, 120, doc.y + 40).fillColor('black');
        doc.moveDown(3);

        doc.fontSize(14).font('Helvetica-Bold').text('TENDER DETAILS', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(10).font('Helvetica');
        const tY = doc.y;
        doc.text('Tender ID:',    50, tY);       doc.text(bid.TenderID,   150, tY);
        doc.text('Category:',    300, tY);       doc.text(bid.CategoryName, 380, tY);
        doc.text('Title:',        50, tY + 20);  doc.text(bid.Title,      150, tY + 20);
        doc.text('Closing Date:', 50, tY + 40);  doc.text(new Date(bid.ClosingDate).toLocaleDateString(), 150, tY + 40);
        doc.text('Est. Budget:', 300, tY + 40);  doc.text(`GHS ${parseFloat(bid.EstimatedBudget).toFixed(2)}`, 430, tY + 40);
        doc.moveDown(4);

        doc.fontSize(14).font('Helvetica-Bold').text('SUPPLIER DETAILS', { underline: true });
        doc.moveDown(0.5);
        doc.fontSize(10).font('Helvetica');
        const sY = doc.y;
        doc.text('Company Name:', 50, sY);       doc.text(bid.CompanyName,        160, sY);
        doc.text('Reg Number:',  300, sY);       doc.text(bid.RegistrationNumber,  400, sY);
        doc.text('Contact:',      50, sY + 20);  doc.text(bid.ContactPerson,       160, sY + 20);
        doc.text('Email:',       300, sY + 20);  doc.text(bid.Email,               350, sY + 20);
        doc.text('Phone:',        50, sY + 40);  doc.text(bid.Phone   || '—',      100, sY + 40);
        doc.text('Address:',     300, sY + 40);  doc.text(bid.Address || '—',      360, sY + 40);
        doc.moveDown(4);

        doc.fontSize(14).font('Helvetica-Bold').text('BID ITEMS', { underline: true });
        doc.moveDown(0.5);
        const cols     = [50, 130, 220, 280, 330, 380, 450];
        const tableTop = doc.y;
        doc.fontSize(9).font('Helvetica-Bold');
        doc.text('Item #',      cols[0], tableTop);
        doc.text('Item Code',   cols[1], tableTop);
        doc.text('Description', cols[2], tableTop);
        doc.text('Unit',        cols[3], tableTop);
        doc.text('Quantity',    cols[4], tableTop, { width: 50, align: 'right' });
        doc.text('Unit Price',  cols[5], tableTop, { width: 60, align: 'right' });
        doc.text('Total',       cols[6], tableTop, { width: 60, align: 'right' });
        doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).stroke();

        let curY = tableTop + 25;
        doc.fontSize(9).font('Helvetica');
        items.forEach(item => {
            if (curY > 700) { doc.addPage(); curY = 50; }
            doc.text(item.ItemNo.toString(),                         cols[0], curY);
            doc.text(item.TenderItemID,                              cols[1], curY, { width: 80 });
            doc.text(item.Description.substring(0, 40),              cols[2], curY, { width: 100 });
            doc.text(item.Unit,                                      cols[3], curY);
            doc.text(item.Quantity.toString(),                       cols[4], curY, { width: 50, align: 'right' });
            doc.text(`GHS ${parseFloat(item.UnitPrice).toFixed(2)}`, cols[5], curY, { width: 60, align: 'right' });
            doc.text(`GHS ${parseFloat(item.Total).toFixed(2)}`,     cols[6], curY, { width: 60, align: 'right' });
            curY += 20;
        });

        curY += 10;
        doc.moveTo(350, curY - 5).lineTo(545, curY - 5).stroke();
        doc.fontSize(12).font('Helvetica-Bold');
        doc.text('GRAND TOTAL:', 350, curY);
        doc.text(`GHS ${parseFloat(bid.GrandTotal).toFixed(2)}`, 450, curY, { align: 'right' });
        doc.fontSize(8).font('Helvetica')
            .text('This is a system-generated receipt. Please retain for your records.', 50, 750, { align: 'center' });

        doc.end();

    } catch (error) {
        console.error('[Download Bid PDF] Error:', error);
        res.status(500).json({ message: error.message });
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
                    ItemNo       AS itemNo,
                    TenderItemID AS tenderItemId,
                    Description  AS description,
                    Unit         AS unit,
                    Quantity     AS quantity,
                    UnitPrice    AS unitPrice,
                    Total        AS total
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