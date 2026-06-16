'use strict';

// routes/tender.routes.js
const express    = require('express');
const router     = express.Router();
const { requireAuth, requireAdmin }           = require('../middleware/auth');
const { getPool, sql }                        = require('../db/procurement');
const { mapTenderStatus }                     = require('../helpers/tenderHelpers');
const { createNotification, getAdminUserIds, getSupplierUserId } = require('../helpers/notifications');
const { generateId }                          = require('../utils/idGenerator');
const { logAudit }                            = require('../helpers/audit');
const { checkAwardEligibility }               = require('../helpers/evaluationHelpers');


// ── GET /api/tenders  — public listing
router.get('/', async (req, res) => {
    try {
        const pool   = await getPool();
        const result = await pool.request().query(`
            SELECT
                t.TenderID          AS id,             t.Title            AS title,
                t.Description       AS description,
                ISNULL(ts.TenderStatusName,'Draft')    AS status,
                t.PublishedDate     AS publishedDate,  t.OpeningDate      AS openingDate,
                t.ClosingDate       AS closingDate,    t.EstimatedBudget  AS estimatedBudget,
                t.CategoryID        AS categoryId,     ISNULL(tc.TenderCategoryName,'') AS category,
                t.CreatedAt         AS createdAt,      t.UpdatedAt        AS updatedAt
            FROM Tender t
            LEFT JOIN TenderStatus   ts ON t.TenderStatusID = ts.TenderStatusID
            LEFT JOIN TenderCategory tc ON t.CategoryID     = tc.TenderCategoryID
            ORDER BY t.CreatedAt DESC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /api/tenders] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── GET /api/tenders/:id  — public
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const pool         = await getPool();
        const tenderResult = await pool.request()
            .input('tenderId', sql.VarChar(50), id)
            .query(`
                SELECT
                    t.TenderID          AS id,          t.Title            AS title,
                    t.Description       AS description, t.TenderStatusID   AS tenderStatusId,
                    ts.TenderStatusName AS status,      t.PublishedDate    AS publishedDate,
                    t.OpeningDate       AS openingDate, t.ClosingDate      AS closingDate,
                    t.EstimatedBudget   AS estimatedBudget,
                    t.CategoryID        AS categoryId,  tc.TenderCategoryName AS category,
                    t.RequiredDocuments AS requiredDocuments,
                    t.CreatedAt         AS createdAt,   t.UpdatedAt        AS updatedAt
                FROM Tender t
                LEFT JOIN TenderStatus   ts ON t.TenderStatusID = ts.TenderStatusID
                LEFT JOIN TenderCategory tc ON t.CategoryID     = tc.TenderCategoryID
                WHERE t.TenderID = @tenderId
            `);

        if (tenderResult.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        const tender = tenderResult.recordset[0];

        try {
            tender.requiredDocuments = tender.requiredDocuments
                ? JSON.parse(tender.requiredDocuments)
                : [];
        } catch {
            tender.requiredDocuments = [];
        }

        const itemsResult = await pool.request()
            .input('tenderId', sql.VarChar(50), id)
            .query(`
                SELECT
                    ItemNo             AS itemNo,
                    TenderItemID       AS tenderItemId,
                    Description        AS description,
                    Unit               AS unit,
                    Quantity           AS quantity,
                    EstimatedUnitPrice AS estimatedUnitPrice
                FROM TenderItem
                WHERE TenderID = @tenderId
                ORDER BY ItemNo ASC
            `);

        tender.items = itemsResult.recordset;
        res.json(tender);
    } catch (error) {
        console.error('[GET /api/tenders/:id] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── Status mapping: Admin DB → Supplier DB
function mapAdminStatusToSupplier(adminStatusId) {
    const statusMap = {
        'D002': 'TS001',
        'D003': 'TS002',
        'D004': 'TS003',
        'D005': 'TS004',
    };
    return statusMap[adminStatusId] || 'TS001';
}

// // ── POST /api/tenders  — admin only 
// router.post('/', requireAdmin, async (req, res) => {
//     const { title, categoryId, description, status, openingDate, closingDate, estimatedBudget, items, requiredDocuments } = req.body;

//     // validate required fields before touching the DB
//     if (!title || !title.trim())
//         return res.status(400).json({ message: 'title is required' });
//     if (!closingDate)
//         return res.status(400).json({ message: 'closingDate is required' });
//     if (!categoryId)
//         return res.status(400).json({ message: 'categoryId is required' });

//     const tenderStatusId = mapTenderStatus(status);
//     const tenderId       = generateId('T');

//     try {
//         const pool = await getPool();

//         await pool.request()
//             .input('tenderId',        sql.VarChar(50),       tenderId)
//             .input('title',           sql.NVarChar(255),     title)
//             .input('categoryId',      sql.VarChar(20),       categoryId)
//             .input('description',     sql.NVarChar(sql.MAX), description || '')
//             .input('statusId',        sql.VarChar(20),       tenderStatusId)
//             .input('publishedDate',   sql.Date,              new Date().toISOString().split('T')[0])
//             .input('openingDate',     sql.Date,              openingDate   || null)
//             .input('closingDate',     sql.Date,              closingDate)
//             .input('estimatedBudget', sql.Decimal(18, 2),    estimatedBudget || 0)
//             .input('requiredDocuments', sql.NVarChar(sql.MAX),
//                 Array.isArray(requiredDocuments) ? JSON.stringify(requiredDocuments) : null)
//             .query(`
//                 INSERT INTO Tender (
//                     TenderID, Title, CategoryID, Description, TenderStatusID,
//                     PublishedDate, OpeningDate, ClosingDate, EstimatedBudget,
//                     RequiredDocuments, CreatedAt, UpdatedAt
//                 ) VALUES (
//                     @tenderId, @title, @categoryId, @description, @statusId,
//                     @publishedDate, @openingDate, @closingDate, @estimatedBudget,
//                     @requiredDocuments, GETDATE(), GETDATE()
//                 )
//             `);

//         if (items && items.length > 0) {
//             for (const item of items) {
//                 await pool.request()
//                     .input('tenderItemId',       sql.VarChar(50),       generateId('TI'))
//                     .input('tenderId',           sql.VarChar(50),       tenderId)
//                     .input('itemNo',             sql.Int,               item.itemNo)
//                     .input('description',        sql.NVarChar(sql.MAX), item.description        || '')
//                     .input('unit',               sql.NVarChar(50),      item.unit               || '')
//                     .input('quantity',           sql.Decimal(18, 2),    item.quantity           || 0)
//                     .input('estimatedUnitPrice', sql.Decimal(18, 2),    item.estimatedUnitPrice || 0)
//                     .query(`
//                         INSERT INTO TenderItem
//                             (TenderItemID, TenderID, ItemNo, Description, Unit, Quantity, EstimatedUnitPrice, CreatedAt)
//                         VALUES
//                             (@tenderItemId, @tenderId, @itemNo, @description, @unit, @quantity, @estimatedUnitPrice, GETDATE())
//                     `);
//             }
//         }

//         // Notify approved suppliers in this category when published as Open
//         if (status === 'Open') {
//             const interestedSuppliers = await pool.request()
//                 .input('categoryId', sql.VarChar(20), categoryId)
//                 .query(`
//                     SELECT DISTINCT su.UserID
//                     FROM SupplierCategories sc
//                     JOIN SystemUser      su ON sc.SupplierID      = su.SupplierID
//                     JOIN SupplierProfile sp ON sc.SupplierID      = sp.SupplierID
//                     JOIN ProfileStatus   ps ON sp.ProfileStatusID = ps.ProfileStatusID
//                     WHERE sc.CategoryID = @categoryId
//                       AND su.Role = 'supplier'
//                       AND ps.ProfileStatusName = 'Approved'
//                 `);

//             for (const row of interestedSuppliers.recordset) {
//                 await createNotification(pool, {
//                     userId:  row.UserID,
//                     message: `A new tender "${title}" has been published in your category.`,
//                     type:    'info',
//                     link:    `/supplier/tenders/${tenderId}`,
//                 });
//             }
//         }

//         await logAudit(pool, req, {
//             action: 'TENDER_CREATE', entityType: 'Tender', entityId: tenderId,
//             description: `Created tender "${title}" (status: ${status || 'Draft'})`,
//         });

//         res.status(201).json({
//             message: 'Tender created successfully',
//             tender:  { id: tenderId, title, categoryId, status, closingDate },
//         });
//     } catch (error) {
//         console.error('[POST /api/tenders] Error:', error);
//         res.status(500).json({ message: error.message });
//     }
// });

// ── POST /api/tenders/sync — called by ASP scheduler only
router.post('/sync', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY)
        return res.status(401).json({ message: 'Unauthorized' });

    const {
        drugtenderid, drugtendername, drugtendercatid, drugtenderstatusid,
        tenderstartdate, tenderenddate, tenderinfo1, tenderdate1, tendervalue1,
    } = req.body;

    const tenderStatusId = mapAdminStatusToSupplier(drugtenderstatusid);

    try {
        const pool = await getPool();

        await pool.request()
            .input('tenderId',        sql.VarChar(50),       drugtenderid)
            .input('title',           sql.NVarChar(255),     drugtendername)
            .input('categoryId',      sql.VarChar(20),       drugtendercatid)
            .input('description',     sql.NVarChar(sql.MAX), tenderinfo1 || '')
            .input('statusId',        sql.VarChar(20),       tenderStatusId)
            .input('publishedDate',   sql.Date,              tenderdate1 || null)
            .input('openingDate',     sql.Date,              tenderstartdate || null)
            .input('closingDate',     sql.Date,              tenderenddate || null)
            .input('estimatedBudget', sql.Decimal(18, 2),    tendervalue1 || 0)
            .query(`
                IF EXISTS (SELECT 1 FROM Tender WHERE TenderID = @tenderId)
                    UPDATE Tender SET
                        Title           = @title,
                        CategoryID      = @categoryId,
                        Description     = @description,
                        TenderStatusID  = @statusId,
                        PublishedDate   = @publishedDate,
                        OpeningDate     = @openingDate,
                        ClosingDate     = @closingDate,
                        EstimatedBudget = @estimatedBudget,
                        UpdatedAt       = GETDATE()
                    WHERE TenderID = @tenderId
                ELSE
                    INSERT INTO Tender (
                        TenderID, Title, CategoryID, Description, TenderStatusID,
                        PublishedDate, OpeningDate, ClosingDate, EstimatedBudget,
                        CreatedAt, UpdatedAt
                    ) VALUES (
                        @tenderId, @title, @categoryId, @description, @statusId,
                        @publishedDate, @openingDate, @closingDate, @estimatedBudget,
                        GETDATE(), GETDATE()
                    )
            `);

        res.json({ success: true });
    } catch (err) {
        console.error('[POST /api/tenders/sync] Error:', err);
        res.status(500).json({ message: err.message });
    }
});


// ── PUT /api/tenders/:id  — admin only
router.put('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { title, categoryId, description, status, openingDate, closingDate, estimatedBudget, items, requiredDocuments } = req.body;

    if (!title || !title.trim())
        return res.status(400).json({ message: 'title is required' });
    if (!closingDate)
        return res.status(400).json({ message: 'closingDate is required' });
    if (!categoryId)
        return res.status(400).json({ message: 'categoryId is required' });

    const tenderStatusId = mapTenderStatus(status);

    try {
        const pool = await getPool();

        const prevResult = await pool.request()
            .input('tenderId', sql.VarChar(50), id)
            .query(`
                SELECT ts.TenderStatusName AS prevStatus
                FROM Tender t
                JOIN TenderStatus ts ON t.TenderStatusID = ts.TenderStatusID
                WHERE t.TenderID = @tenderId
            `);

        const prevStatus = prevResult.recordset[0]?.prevStatus || null;

        const result = await pool.request()
            .input('tenderId',        sql.VarChar(50),       id)
            .input('title',           sql.NVarChar(255),     title)
            .input('categoryId',      sql.VarChar(20),       categoryId)
            .input('description',     sql.NVarChar(sql.MAX), description || '')
            .input('statusId',        sql.VarChar(20),       tenderStatusId)
            .input('openingDate',     sql.Date,              openingDate   || null)
            .input('closingDate',     sql.Date,              closingDate)
            .input('estimatedBudget', sql.Decimal(18, 2),    estimatedBudget || 0)
            .input('requiredDocuments', sql.NVarChar(sql.MAX),
                Array.isArray(requiredDocuments) ? JSON.stringify(requiredDocuments) : null)
            .query(`
                UPDATE Tender SET
                    Title             = @title,       CategoryID      = @categoryId,
                    Description       = @description, TenderStatusID  = @statusId,
                    OpeningDate       = @openingDate, ClosingDate     = @closingDate,
                    EstimatedBudget   = @estimatedBudget,
                    RequiredDocuments = @requiredDocuments, UpdatedAt = GETDATE()
                WHERE TenderID = @tenderId
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Tender not found' });

        if (items !== undefined) {
            const existingItems   = await pool.request()
                .input('tenderId', sql.VarChar(50), id)
                .query(`SELECT ItemNo FROM TenderItem WHERE TenderID = @tenderId`);

            const existingItemNos = existingItems.recordset.map(r => r.ItemNo);
            const incomingItemNos = items.map(i => i.itemNo);

            for (const itemNo of existingItemNos.filter(no => !incomingItemNos.includes(no))) {
                await pool.request()
                    .input('tenderId', sql.VarChar(50), id)
                    .input('itemNo',   sql.Int,         itemNo)
                    .query(`DELETE FROM TenderItem WHERE TenderID = @tenderId AND ItemNo = @itemNo`);
            }

            for (const item of items) {
                await pool.request()
                    .input('tenderItemId',       sql.VarChar(50),       generateId('TI'))
                    .input('tenderId',           sql.VarChar(50),       id)
                    .input('itemNo',             sql.Int,               item.itemNo)
                    .input('description',        sql.NVarChar(sql.MAX), item.description        || '')
                    .input('unit',               sql.NVarChar(50),      item.unit               || '')
                    .input('quantity',           sql.Decimal(18, 2),    item.quantity           || 0)
                    .input('estimatedUnitPrice', sql.Decimal(18, 2),    item.estimatedUnitPrice || 0)
                    .query(`
                        IF EXISTS (SELECT 1 FROM TenderItem WHERE TenderID = @tenderId AND ItemNo = @itemNo)
                            UPDATE TenderItem SET
                                Description        = @description,
                                Unit               = @unit,
                                Quantity           = @quantity,
                                EstimatedUnitPrice = @estimatedUnitPrice
                            WHERE TenderID = @tenderId AND ItemNo = @itemNo
                        ELSE
                            INSERT INTO TenderItem
                                (TenderItemID, TenderID, ItemNo, Description, Unit, Quantity, EstimatedUnitPrice, CreatedAt)
                            VALUES
                                (@tenderItemId, @tenderId, @itemNo, @description, @unit, @quantity, @estimatedUnitPrice, GETDATE())
                    `);
            }
        }

        if (status === 'Open' && prevStatus !== 'Open') {
            const interestedSuppliers = await pool.request()
                .input('categoryId', sql.VarChar(20), categoryId)
                .query(`
                    SELECT DISTINCT su.UserID
                    FROM SupplierCategories sc
                    JOIN SystemUser      su ON sc.SupplierID      = su.SupplierID
                    JOIN SupplierProfile sp ON sc.SupplierID      = sp.SupplierID
                    JOIN ProfileStatus   ps ON sp.ProfileStatusID = ps.ProfileStatusID
                    WHERE sc.CategoryID = @categoryId
                      AND su.Role = 'supplier'
                      AND ps.ProfileStatusName = 'Approved'
                `);

            for (const row of interestedSuppliers.recordset) {
                await createNotification(pool, {
                    userId:  row.UserID,
                    message: `Tender "${title}" is now open for bidding.`,
                    type:    'info',
                    link:    `/supplier/tenders/${id}`,
                });
            }
        }

        await logAudit(pool, req, {
            action: 'TENDER_UPDATE', entityType: 'Tender', entityId: id,
            description: `Updated tender "${title}"${prevStatus !== status ? ` (status: ${prevStatus} → ${status})` : ''}`,
        });

        res.json({ message: 'Tender updated successfully' });
    } catch (error) {
        console.error('[PUT /api/tenders/:id] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── DELETE /api/tenders/:id  — admin only, Draft status only
router.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const pool        = await getPool();
        const checkResult = await pool.request()
            .input('tenderId', sql.VarChar(50), id)
            .query(`
                SELECT ts.TenderStatusName
                FROM Tender t
                JOIN TenderStatus ts ON t.TenderStatusID = ts.TenderStatusID
                WHERE t.TenderID = @tenderId
            `);

        if (checkResult.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        const status = checkResult.recordset[0].TenderStatusName;
        if (status !== 'Draft')
            return res.status(403).json({
                message: `Cannot delete a tender with status '${status}'. Only Draft tenders can be deleted.`,
            });

        const result = await pool.request()
            .input('tenderId', sql.VarChar(50), id)
            .query(`DELETE FROM Tender WHERE TenderID = @tenderId`);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Tender not found' });

        await logAudit(pool, req, {
            action: 'TENDER_DELETE', entityType: 'Tender', entityId: id,
            description: `Deleted draft tender ${id}`,
        });

        res.json({ message: 'Tender deleted successfully' });
    } catch (error) {
        console.error('[DELETE /api/tenders/:id] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── GET /api/tenders/:id/interests  — admin only
router.get('/:id/interests', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('tenderId', sql.VarChar(50), id)
            .query(`
                SELECT
                    i.SupplierID   AS supplierId,
                    sp.CompanyName AS supplierName,
                    i.InterestDate AS date
                FROM Interests i
                JOIN SupplierProfile sp ON i.SupplierID = sp.SupplierID
                WHERE i.TenderID = @tenderId
                ORDER BY i.InterestDate DESC
            `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET tender interests] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── POST /api/tenders/:id/interest  — auth required
router.post('/:id/interest', requireAuth, async (req, res) => {
    const { id }           = req.params;
    const { supplierId }   = req.body;
    const { userId, role } = req.user;

    if (!supplierId)
        return res.status(400).json({ message: 'Supplier ID is required' });

    if (role === 'supplier' && userId !== supplierId)
        return res.status(403).json({ message: 'You can only express interest on your own behalf' });

    try {
        const pool     = await getPool();
        const existing = await pool.request()
            .input('tenderId',   sql.VarChar(50), id)
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT 1 FROM Interests WHERE TenderID = @tenderId AND SupplierID = @supplierId`);

        if (existing.recordset.length > 0)
            return res.json({ message: 'Interest already expressed', alreadyInterested: true });

        await pool.request()
            .input('tenderId',     sql.VarChar(50), id)
            .input('supplierId',   sql.VarChar(50), supplierId)
            .input('interestDate', sql.Date,        new Date().toISOString().split('T')[0])
            .query(`
                INSERT INTO Interests (TenderID, SupplierID, InterestDate)
                VALUES (@tenderId, @supplierId, @interestDate)
            `);

        const infoResult = await pool.request()
            .input('tenderId',   sql.VarChar(50), id)
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`
                SELECT t.Title AS tenderTitle, sp.CompanyName AS companyName
                FROM Tender t
                CROSS JOIN SupplierProfile sp
                WHERE t.TenderID = @tenderId AND sp.SupplierID = @supplierId
            `);
        const info     = infoResult.recordset[0] || {};
        const adminIds = await getAdminUserIds(pool);
        for (const adminUserId of adminIds) {
            await createNotification(pool, {
                userId:   adminUserId,
                userType: 'admin',
                message:  `${info.companyName || 'A supplier'} expressed interest in "${info.tenderTitle || id}".`,
                type:     'info',
                link:     `/admin/tenders/${id}`,
            });
        }

        res.json({ message: 'Interest expressed successfully' });
    } catch (error) {
        console.error('[POST tender interest] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── GET /api/tenders/:tenderId/items/:itemNo/awards  — admin only
router.get('/:tenderId/items/:itemNo/awards', requireAdmin, async (req, res) => {
    const { tenderId, itemNo } = req.params;
    try {
        const pool = await getPool();

        const itemResult = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .input('itemNo',   sql.Int,         parseInt(itemNo))
            .query(`
                SELECT TenderItemID, Description, Unit, Quantity, EstimatedUnitPrice
                FROM TenderItem
                WHERE TenderID = @tenderId AND ItemNo = @itemNo
            `);

        if (itemResult.recordset.length === 0)
            return res.status(404).json({ message: 'Tender item not found' });

        const tenderItem = itemResult.recordset[0];

        const bidsResult = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .input('itemNo',   sql.Int,         parseInt(itemNo))
            .query(`
                SELECT
                    b.BidID, b.SupplierID, b.BidStatusID,
                    sp.CompanyName, sp.ContactPerson,
                    bi.Quantity, bi.UnitPrice, bi.Total,
                    bs.BidStatusName AS BidStatus
                FROM Bid b
                JOIN SupplierProfile sp ON b.SupplierID = sp.SupplierID
                JOIN BidItem         bi ON b.BidID = bi.BidID AND bi.ItemNo = @itemNo
                JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
                WHERE b.TenderID = @tenderId
                ORDER BY bi.UnitPrice ASC
            `);

        const awardResult = await pool.request()
            .input('tenderId',     sql.VarChar(50), tenderId)
            .input('tenderItemId', sql.VarChar(50), tenderItem.TenderItemID)
            .query(`
                SELECT * FROM TenderItemAward
                WHERE TenderID = @tenderId AND TenderItemID = @tenderItemId
            `);

        res.json({
            tenderItem: {
                id:                 tenderItem.TenderItemID,
                itemNo:             parseInt(itemNo),
                description:        tenderItem.Description,
                unit:               tenderItem.Unit,
                quantity:           tenderItem.Quantity,
                estimatedUnitPrice: tenderItem.EstimatedUnitPrice,
            },
            bids:           bidsResult.recordset,
            existingAward:  awardResult.recordset[0] || null,
            existingAwards: awardResult.recordset,
        });
    } catch (error) {
        console.error('[GET /tenders/:tenderId/items/:itemNo/awards] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── POST /api/tenders/:tenderId/items/:itemNo/award  — admin only
router.post('/:tenderId/items/:itemNo/award', requireAdmin, async (req, res) => {
    const { tenderId, itemNo } = req.params;
    const { bidId, supplierId, awardedQuantity, awardedUnitPrice, awardedTotal, awardNote } = req.body;

    if (!bidId || !supplierId)
        return res.status(400).json({ message: 'Bid ID and Supplier ID are required' });

    try {
        const pool = await getPool();

        // ── Award gate — all five eligibility checks
        const eligibility = await checkAwardEligibility(pool, sql, tenderId);
        if (!eligibility.eligible)
            return res.status(400).json({ message: eligibility.reason });

        // Supplier must be responsive
        if (!eligibility.responsiveSupplierIds.includes(supplierId))
            return res.status(400).json({
                message: 'This supplier was found non-responsive during evaluation and cannot be awarded.',
            });

        const itemResult = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .input('itemNo',   sql.Int,         parseInt(itemNo))
            .query(`SELECT TenderItemID FROM TenderItem WHERE TenderID = @tenderId AND ItemNo = @itemNo`);

        if (itemResult.recordset.length === 0)
            return res.status(404).json({ message: 'Tender item not found' });

        // Reject if bid has been rejected
        const bidStatusResult = await pool.request()
            .input('bidId', sql.VarChar(50), bidId)
            .query(`
                SELECT bs.BidStatusName
                FROM Bid b
                JOIN BidStatus bs ON b.BidStatusID = bs.BidStatusID
                WHERE b.BidID = @bidId
            `);

        if (bidStatusResult.recordset.length === 0)
            return res.status(404).json({ message: 'Bid not found' });

        if (bidStatusResult.recordset[0].BidStatusName === 'Rejected')
            return res.status(400).json({
                message: 'Cannot award an item to a supplier whose bid has been rejected.',
            });

        const tenderItemId = itemResult.recordset[0].TenderItemID;
        const awardId      = generateId('AWARD');

        await pool.request()
            .input('tenderId',     sql.VarChar(50), tenderId)
            .input('tenderItemId', sql.VarChar(50), tenderItemId)
            .query(`DELETE FROM TenderItemAward WHERE TenderID = @tenderId AND TenderItemID = @tenderItemId`);

        await pool.request()
            .input('awardId',          sql.VarChar(50),       awardId)
            .input('tenderItemId',     sql.VarChar(50),       tenderItemId)
            .input('tenderId',         sql.VarChar(50),       tenderId)
            .input('bidId',            sql.VarChar(50),       bidId)
            .input('supplierId',       sql.VarChar(50),       supplierId)
            .input('awardedQuantity',  sql.Decimal(18, 2),    awardedQuantity  || 0)
            .input('awardedUnitPrice', sql.Decimal(18, 2),    awardedUnitPrice || 0)
            .input('awardedTotal',     sql.Decimal(18, 2),    awardedTotal     || 0)
            .input('awardNote',        sql.NVarChar(sql.MAX), awardNote        || null)
            .query(`
                INSERT INTO TenderItemAward (
                    AwardID, TenderItemID, TenderID, BidID, SupplierID,
                    AwardedQuantity, AwardedUnitPrice, AwardedTotal, AwardDate, AwardNote
                ) VALUES (
                    @awardId, @tenderItemId, @tenderId, @bidId, @supplierId,
                    @awardedQuantity, @awardedUnitPrice, @awardedTotal, GETDATE(), @awardNote
                )
            `);

        // Flip tender to Awarded once all items are covered
        await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                UPDATE Tender SET TenderStatusID = 'TS004', UpdatedAt = GETDATE()
                WHERE TenderID = @tenderId
                  AND (SELECT COUNT(*)                     FROM TenderItem      WHERE TenderID = @tenderId)
                    = (SELECT COUNT(DISTINCT TenderItemID) FROM TenderItemAward WHERE TenderID = @tenderId)
                  AND TenderStatusID <> 'TS004'
            `);

        const supplierUserId = await getSupplierUserId(pool, supplierId);
        if (supplierUserId) {
            const infoResult = await pool.request()
                .input('tenderId', sql.VarChar(50), tenderId)
                .input('itemNo',   sql.Int,         parseInt(itemNo))
                .query(`
                    SELECT t.Title AS tenderTitle, ti.Description AS itemDescription
                    FROM Tender t
                    JOIN TenderItem ti ON ti.TenderID = t.TenderID AND ti.ItemNo = @itemNo
                    WHERE t.TenderID = @tenderId
                `);
            const info = infoResult.recordset[0] || {};
            await createNotification(pool, {
                userId:   supplierUserId,
                userType: 'supplier',
                message:  `You have been awarded the item "${info.itemDescription || 'an item'}" in tender "${info.tenderTitle || tenderId}".`,
                type:     'success',
                link:     '/supplier/bids',
            });
        }

        await logAudit(pool, req, {
            action: 'TENDER_ITEM_AWARD', entityType: 'Tender', entityId: tenderId,
            description: `Awarded item #${itemNo} of tender ${tenderId} to supplier ${supplierId} (qty ${awardedQuantity || 0}, total ${awardedTotal || 0})`,
        });

        res.json({ message: 'Item awarded successfully', awardId });
    } catch (error) {
        console.error('[POST /tenders/:tenderId/items/:itemNo/award] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── POST /api/tenders/:tenderId/items/:itemNo/split-award  — admin only
router.post('/:tenderId/items/:itemNo/split-award', requireAdmin, async (req, res) => {
    const { tenderId, itemNo } = req.params;
    const { allocations, awardNote } = req.body;

    if (!Array.isArray(allocations) || allocations.length === 0)
        return res.status(400).json({ message: 'At least one allocation is required' });

    try {
        const pool = await getPool();

        // ── Award gate — all five eligibility checks
        const eligibility = await checkAwardEligibility(pool, sql, tenderId);
        if (!eligibility.eligible)
            return res.status(400).json({ message: eligibility.reason });

        const itemResult = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .input('itemNo',   sql.Int,         parseInt(itemNo))
            .query(`SELECT TenderItemID, Quantity, Description FROM TenderItem WHERE TenderID = @tenderId AND ItemNo = @itemNo`);

        if (itemResult.recordset.length === 0)
            return res.status(404).json({ message: 'Tender item not found' });

        const tenderItemId    = itemResult.recordset[0].TenderItemID;
        const tenderQuantity  = Number(itemResult.recordset[0].Quantity) || 0;
        const itemDescription = itemResult.recordset[0].Description;

        const bidsResult = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .input('itemNo',   sql.Int,         parseInt(itemNo))
            .query(`
                SELECT b.BidID, b.SupplierID, bi.Quantity, bi.UnitPrice, bs.BidStatusName AS BidStatus
                FROM Bid b
                JOIN BidItem   bi ON b.BidID = bi.BidID AND bi.ItemNo = @itemNo
                JOIN BidStatus bs ON b.BidStatusID = bs.BidStatusID
                WHERE b.TenderID = @tenderId
            `);
        const bidMap = {};
        bidsResult.recordset.forEach(r => { bidMap[r.BidID] = r; });

        const seenBids = new Set();
        let totalAllocated = 0;
        for (const a of allocations) {
            if (!a.bidId || !a.supplierId)
                return res.status(400).json({ message: 'Each allocation needs a bidId and supplierId' });
            if (seenBids.has(a.bidId))
                return res.status(400).json({ message: 'Each supplier can only appear once in the split' });
            seenBids.add(a.bidId);

            const bid = bidMap[a.bidId];
            if (!bid)
                return res.status(400).json({ message: 'A selected bid does not include this item' });
            if (bid.SupplierID !== a.supplierId)
                return res.status(400).json({ message: 'Allocation supplier does not match the bid' });
            if (bid.BidStatus === 'Rejected')
                return res.status(400).json({ message: 'Cannot award to a supplier whose bid has been rejected.' });

            // Supplier must be responsive
            if (!eligibility.responsiveSupplierIds.includes(bid.SupplierID))
                return res.status(400).json({
                    message: `Supplier ${bid.SupplierID} was found non-responsive during evaluation and cannot be awarded.`,
                });

            const qty = Number(a.awardedQuantity) || 0;
            if (qty <= 0)
                return res.status(400).json({ message: 'Each allocation quantity must be greater than 0' });
            if (qty > Number(bid.Quantity))
                return res.status(400).json({ message: `Cannot award a supplier more than they bid (max ${bid.Quantity}).` });

            totalAllocated += qty;
        }

        if (Math.abs(totalAllocated - tenderQuantity) > 0.001)
            return res.status(400).json({
                message: `Allocated quantity (${totalAllocated}) must equal the tender quantity (${tenderQuantity}).`,
            });

        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            await transaction.request()
                .input('tenderId',     sql.VarChar(50), tenderId)
                .input('tenderItemId', sql.VarChar(50), tenderItemId)
                .query(`DELETE FROM TenderItemAward WHERE TenderID = @tenderId AND TenderItemID = @tenderItemId`);

            for (const a of allocations) {
                const bid       = bidMap[a.bidId];
                const qty       = Number(a.awardedQuantity) || 0;
                const unitPrice = Number(bid.UnitPrice) || 0;
                await transaction.request()
                    .input('awardId',          sql.VarChar(50),       generateId('AWARD'))
                    .input('tenderItemId',     sql.VarChar(50),       tenderItemId)
                    .input('tenderId',         sql.VarChar(50),       tenderId)
                    .input('bidId',            sql.VarChar(50),       a.bidId)
                    .input('supplierId',       sql.VarChar(50),       a.supplierId)
                    .input('awardedQuantity',  sql.Decimal(18, 2),    qty)
                    .input('awardedUnitPrice', sql.Decimal(18, 2),    unitPrice)
                    .input('awardedTotal',     sql.Decimal(18, 2),    qty * unitPrice)
                    .input('awardNote',        sql.NVarChar(sql.MAX), awardNote || null)
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

            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                UPDATE Tender SET TenderStatusID = 'TS004', UpdatedAt = GETDATE()
                WHERE TenderID = @tenderId
                  AND (SELECT COUNT(*)                     FROM TenderItem      WHERE TenderID = @tenderId)
                    = (SELECT COUNT(DISTINCT TenderItemID) FROM TenderItemAward WHERE TenderID = @tenderId)
                  AND TenderStatusID <> 'TS004'
            `);

        const tInfo       = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT Title FROM Tender WHERE TenderID = @tenderId`);
        const tenderTitle = tInfo.recordset[0]?.Title || tenderId;

        for (const a of allocations) {
            const supplierUserId = await getSupplierUserId(pool, a.supplierId);
            if (supplierUserId) {
                await createNotification(pool, {
                    userId:   supplierUserId,
                    userType: 'supplier',
                    message:  `You have been awarded ${a.awardedQuantity} unit(s) of "${itemDescription}" in tender "${tenderTitle}".`,
                    type:     'success',
                    link:     '/supplier/bids',
                });
            }
        }

        await logAudit(pool, req, {
            action: 'TENDER_ITEM_SPLIT_AWARD', entityType: 'Tender', entityId: tenderId,
            description: `Split-awarded item #${itemNo} of tender ${tenderId} across ${allocations.length} supplier(s): ${allocations.map(a => `${a.supplierId} (${a.awardedQuantity})`).join(', ')}`,
        });

        res.json({ message: 'Item split-awarded successfully' });
    } catch (error) {
        console.error('[POST /tenders/:tenderId/items/:itemNo/split-award] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── GET /api/tenders/:tenderId/awards  — admin only
router.get('/:tenderId/awards', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT
                    tia.AwardID, tia.TenderItemID, tia.BidID, tia.SupplierID,
                    tia.AwardedQuantity, tia.AwardedUnitPrice, tia.AwardedTotal,
                    tia.AwardDate, tia.AwardNote,
                    ti.ItemNo, ti.Description AS ItemDescription,
                    sp.CompanyName AS SupplierName
                FROM TenderItemAward tia
                JOIN TenderItem      ti ON tia.TenderItemID = ti.TenderItemID
                JOIN SupplierProfile sp ON tia.SupplierID   = sp.SupplierID
                WHERE tia.TenderID = @tenderId
            `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /tenders/:tenderId/awards] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;