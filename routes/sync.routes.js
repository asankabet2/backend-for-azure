'use strict';

const express = require('express');
const router = express.Router();
const { mapTenderStatus } = require('../helpers/tenderHelpers');
const { getPool, sql } = require('../db/procurement');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');
const crypto = require('crypto');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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


function keyMatches(provided, expected) {
    if (!provided || !expected) return false;
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isNumOrNull(v) {
    return v === null || v === undefined || v === '' ||
        (typeof v === 'number' && Number.isFinite(v));
}

// ── Tender type (HMS DrugTenderType) → portal TenderCategory
const TYPE_TO_CATEGORY = {
    'S001':   'CAT0002', // DRUGS            → Pharmaceuticals
    'S002':   'CAT0001', // SURGICAL EQUIP   → Medical Supplies
    'STY001': 'CAT0010', // Other            → Other
    'STY002': 'CAT0004', // Stationery       → Office Supplies
    'STY003': 'CAT0003', // IT & Electronics → IT & Electronics
    'STY004': 'CAT0005', // Cleaning & Sanitation
    'STY005': 'CAT0007', // Catering
    'STY006': 'CAT0008', // Construction
    'STY007': 'CAT0009', // Consultancy
    'STY009': 'CAT0007', // Food Items       → Catering
};

const DEFAULT_REQUIRED_DOCUMENTS = JSON.stringify([
    'fdaCertificate', 'graClearance', 'ssnitClearance', 'ppaCertificate'
]);

// e.g. DT000002-0000114 (tender ID + drug ID, so it is the same every time)
// function newTenderItemId(tenderId, drugId) {
//     const id = `${tenderId}-${drugId}`;
//     if (id.length > 50) {
//         throw new Error(`TenderItemID for tender ${tenderId} / drug ${drugId} is longer than 50 characters`);
//     }
//     return id;
// }

// ── Blob client (shared across requests, matches the pattern used for db/procurement.js's pooled connection)
const CONTAINER_NAME = 'supplier-documents';
let blobServiceClient = null;
function getBlobServiceClient() {
    if (!blobServiceClient) {
        const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
        blobServiceClient = new BlobServiceClient(
            `https://${accountName}.blob.core.windows.net`,
            new DefaultAzureCredential()
        );
    }
    return blobServiceClient;
}


function safeEqual(a, b) {
    const ab = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
// Only allow blob paths shaped like "<SupplierID>/<docType>-<timestamp>.<ext>",

const SAFE_DOC_PATH_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+-\d+\.(pdf|png|jpe?g|docx?)$/i;

const CONTENT_TYPES = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// ── GET /api/sync/suppliers ──
router.get('/suppliers', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { lastSyncDate } = req.query;

    try {
        const pool = await getPool();

        let query = `
            SELECT 
                sp.SupplierID, sp.RegistrationNumber, sp.CompanyName, sp.TIN,
                sp.ContactPerson, sp.Designation, sp.Email, sp.Phone, sp.Address,
                sp.CityID, sp.RegionID, sp.CountryID, sp.ProfileStatusID, sp.RejectionReason,
                sp.DateApplied, sp.CreatedAt, sp.UpdateDate, c.CityName
            FROM SupplierProfile sp
            LEFT JOIN Cities c ON sp.CityID = c.CityID
            WHERE sp.ProfileStatusID IN ('PS002', 'PS001')
        `;

        if (lastSyncDate) {
            query += ` AND (sp.CreatedAt > @lastSyncDate OR sp.UpdateDate > @lastSyncDate)`;
        }

        query += ` ORDER BY sp.CreatedAt DESC`;

        const request = pool.request();
        if (lastSyncDate) {
            request.input('lastSyncDate', sql.DateTime, lastSyncDate);
        }

        const result = await request.query(query);

        // Fetch all categories in one query instead of one per supplier
        if (result.recordset.length > 0) {
            const ids = result.recordset.map(s => `'${s.SupplierID}'`).join(',');
            const catResult = await pool.request().query(`
                SELECT SupplierID, CategoryID
                FROM SupplierCategories
                WHERE SupplierID IN (${ids})
                ORDER BY CategoryID ASC
            `);

            const catMap = {};
            for (const row of catResult.recordset) {
                if (!catMap[row.SupplierID]) catMap[row.SupplierID] = [];
                catMap[row.SupplierID].push(row.CategoryID);
            }

            for (const supplier of result.recordset) {
                supplier.Categories = catMap[supplier.SupplierID] || [];
            }
        } else {
            for (const supplier of result.recordset) {
                supplier.Categories = [];
            }
        }

        res.json({
            success: true,
            suppliers: result.recordset,
            count: result.recordset.length
        });

    } catch (err) {
        console.error('[GET /api/sync/suppliers] Error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});


// ── POST /api/sync/tenders ──
// Upserts a tender and (optionally) its items in one transaction.
router.post('/tenders', async (req, res) => {
    if (!keyMatches(req.headers['x-sync-api-key'], process.env.SYNC_API_KEY)) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const bad = (message) => res.status(400).json({ success: false, message });

    const {
        drugtenderid, drugtendername, drugtendercatid, drugtendertypeid, drugtenderstatusid,
        tenderstartdate, tenderenddate, tenderinfo1, remarks, tenderdate1, tendervalue1, items,
    } = req.body;

    const tenderId = drugtenderid == null ? '' : String(drugtenderid).trim();
    const title = drugtendername == null ? '' : String(drugtendername).trim();
    if (!tenderId || !title) return bad('drugtenderid and drugtendername are required');
    if (tenderId.length > 50) return bad('drugtenderid is longer than 50 characters');
    if (title.length > 255) return bad('drugtendername is longer than 255 characters');

    // Category: new flow sends the tender type, old flow sent the category directly
    let categoryId = drugtendercatid || null;
    if (drugtendertypeid) {
        categoryId = TYPE_TO_CATEGORY[drugtendertypeid];
        if (!categoryId) return bad(`Tender type ${drugtendertypeid} has no matching portal category`);
    }
    if (!categoryId) return bad('Neither drugtendertypeid nor drugtendercatid was sent');

    const tenderStatusId = mapAdminStatusToSupplier(drugtenderstatusid);
    if (!tenderStatusId) return bad(`Tender status ${drugtenderstatusid} has no matching portal status`);

    // Dates must be yyyy-mm-dd (or empty)
    const dates = { tenderdate1, tenderstartdate, tenderenddate };
    for (const [name, v] of Object.entries(dates)) {
        if (v !== null && v !== undefined && v !== '' &&
            (!ISO_DATE.test(v) || isNaN(new Date(v + 'T00:00:00Z').getTime()))) {
            return bad(`${name} must be yyyy-mm-dd`);
        }
    }

    // Budget must be numeric (or empty)
    if (!isNumOrNull(tendervalue1)) return bad('tendervalue1 must be a number');
    const budget = (tendervalue1 === '' || tendervalue1 == null) ? 0 : tendervalue1;

    // Items: trim drugId, validate, reject duplicates (case-insensitive, like the DB collation)
    const itemList = [];
    const seenDrugs = new Set();
    const rawItems = Array.isArray(items) ? items : [];
    for (let i = 0; i < rawItems.length; i++) {
        const it = rawItems[i];
        const drugId = it && it.drugId != null ? String(it.drugId).trim() : '';
        if (!drugId) return bad(`Item ${i + 1} has no drugId`);
        if ((tenderId.length + 1 + drugId.length) > 50) {
            return bad(`Item ${i + 1}: TenderItemID would exceed 50 characters`);
        }
        const key = drugId.toUpperCase();
        if (seenDrugs.has(key)) return bad(`Drug ${drugId} appears more than once`);
        seenDrugs.add(key);
        if (!isNumOrNull(it.quantity)) return bad(`Item ${i + 1}: quantity must be a number`);
        if (!isNumOrNull(it.estimatedUnitPrice)) return bad(`Item ${i + 1}: estimatedUnitPrice must be a number`);
        if (it.unit != null && String(it.unit).length > 50) return bad(`Item ${i + 1}: unit is longer than 50 characters`);
        itemList.push({ ...it, drugId });
    }

    let transaction;
    try {
        const pool = await getPool();
        transaction = new sql.Transaction(pool);
        await transaction.begin();

        await transaction.request()
            .input('tenderId',        sql.VarChar(50),       tenderId)
            .input('title',           sql.NVarChar(255),     title)
            .input('categoryId',      sql.VarChar(20),       categoryId)
            .input('description',     sql.NVarChar(sql.MAX), tenderinfo1 || remarks || '')
            .input('statusId',        sql.VarChar(20),       tenderStatusId)
            .input('publishedDate',   sql.Date,              tenderdate1 || null)
            .input('openingDate',     sql.Date,              tenderstartdate || null)
            .input('closingDate',     sql.Date,              tenderenddate || null)
            .input('estimatedBudget', sql.Decimal(18, 2),    budget)
            .input('requiredDocs',    sql.NVarChar(sql.MAX), DEFAULT_REQUIRED_DOCUMENTS)
            .query(`
                IF EXISTS (SELECT 1 FROM Tender WITH (UPDLOCK, HOLDLOCK) WHERE TenderID = @tenderId)
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
                        RequiredDocuments, CreatedAt, UpdatedAt
                    ) VALUES (
                        @tenderId, @title, @categoryId, @description, @statusId,
                        @publishedDate, @openingDate, @closingDate, @estimatedBudget,
                        @requiredDocs, GETDATE(), GETDATE()
                    )
            `);

        // Items match on TenderID + DrugID. Existing TenderItemID and ItemNo are never changed
        // (bids point at them). New items get ItemNo = current max + position, never the HMS itemNo,
        // because the PK is (TenderID, ItemNo) and HMS renumbers by drug name on every push.
        // The Tender row is locked above, so concurrent pushes of this tender queue up here.
        if (itemList.length > 0) {
            await transaction.request()
                .input('tenderId', sql.VarChar(50),       tenderId)
                .input('items',    sql.NVarChar(sql.MAX), JSON.stringify(itemList))
                .query(`
                    UPDATE ti SET
                        Description        = COALESCE(j.description, ti.Description),
                        Unit               = COALESCE(j.unit, ti.Unit),
                        Quantity           = COALESCE(j.quantity, ti.Quantity, 0),
                        EstimatedUnitPrice = COALESCE(j.estimatedUnitPrice, ti.EstimatedUnitPrice, 0)
                    FROM TenderItem ti
                    INNER JOIN OPENJSON(@items) WITH (
                        drugId             nvarchar(50)  '$.drugId',
                        description        nvarchar(max) '$.description',
                        unit               nvarchar(50)  '$.unit',
                        quantity           decimal(18,2) '$.quantity',
                        estimatedUnitPrice decimal(18,4) '$.estimatedUnitPrice'
                    ) j ON ti.DrugID = j.drugId
                    WHERE ti.TenderID = @tenderId;

                    DECLARE @baseNo int =
                        ISNULL((SELECT MAX(ItemNo) FROM TenderItem WHERE TenderID = @tenderId), 0);

                    INSERT INTO TenderItem
                        (TenderItemID, TenderID, ItemNo, Description, Unit,
                         Quantity, EstimatedUnitPrice, CreatedAt, DrugID)
                    SELECT @tenderId + '-' + j.drugId,
                           @tenderId,
                           @baseNo + ROW_NUMBER() OVER (ORDER BY j.itemNo, j.drugId),
                           ISNULL(j.description, ''),
                           ISNULL(j.unit, ''),
                           ISNULL(j.quantity, 0),
                           ISNULL(j.estimatedUnitPrice, 0),
                           GETDATE(),
                           j.drugId
                    FROM OPENJSON(@items) WITH (
                        itemNo             int           '$.itemNo',
                        drugId             nvarchar(50)  '$.drugId',
                        description        nvarchar(max) '$.description',
                        unit               nvarchar(50)  '$.unit',
                        quantity           decimal(18,2) '$.quantity',
                        estimatedUnitPrice decimal(18,4) '$.estimatedUnitPrice'
                    ) j
                    WHERE NOT EXISTS (
                        SELECT 1 FROM TenderItem x
                        WHERE x.TenderID = @tenderId AND x.DrugID = j.drugId
                    );
                `);
        }

        await transaction.commit();
        res.json({ success: true, items: itemList.length });
    } catch (err) {
        if (transaction) {
            try { await transaction.rollback(); } catch (rbErr) { /* keep the original error */ }
        }
        console.error('[POST /api/sync/tenders] Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── PATCH /api/sync/suppliers/:supplierId/status ──
router.patch('/suppliers/:supplierId/status', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { supplierId } = req.params;
    const { status, rejectionReason } = req.body;

    const allowed = ['PS001', 'PS002', 'PS003', 'PS004'];
    if (!allowed.includes(status))
        return res.status(400).json({ success: false, message: 'Invalid status' });

    try {
        const pool = await getPool();
        await pool.request()
            .input('supplierId',      sql.VarChar(50),    supplierId)
            .input('status',          sql.VarChar(20),    status)
            .input('rejectionReason', sql.NVarChar(500),  rejectionReason || null)
            .query(`
                UPDATE SupplierProfile
                SET ProfileStatusID = @status,
                    RejectionReason = @rejectionReason,
                    UpdateDate       = GETDATE()
                WHERE SupplierID = @supplierId
            `);

        res.json({ success: true });
    } catch (error) {
        console.error('[PATCH /sync/suppliers/:id/status] Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ── GET /api/sync/documents/stream?path=<SupplierID>/<fileName> ──
// Streams a single supplier document straight from Blob Storage — nothing

router.get('/documents/stream', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const path = req.query.path;

    if (!path || typeof path !== 'string') {
        return res.status(400).json({ message: 'Missing path query parameter' });
    }

    if (!SAFE_DOC_PATH_PATTERN.test(path)) {
        return res.status(400).json({ message: 'Invalid document path' });
    }

    try {
        const containerClient = getBlobServiceClient().getContainerClient(CONTAINER_NAME);
        const blobClient = containerClient.getBlobClient(path);

        const exists = await blobClient.exists();
        if (!exists) {
            return res.status(404).json({ message: 'Document not found' });
        }

        const ext = path.split('.').pop().toLowerCase();
        const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

        const downloadResponse = await blobClient.download();

        res.setHeader('Content-Type', contentType);
        if (downloadResponse.contentLength) {
            res.setHeader('Content-Length', downloadResponse.contentLength);
        }
        // inline, not attachment — HMS renders it in-browser rather than forcing a download
        res.setHeader('Content-Disposition', 'inline');

        downloadResponse.readableStreamBody.pipe(res);
    } catch (err) {
        console.error('[GET /api/sync/documents/stream] Error:', err);
        res.status(500).json({ message: err.message });
    }
});

// ── GET /api/sync/suppliers/documents ──
router.get('/suppliers/documents', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { lastSyncDate } = req.query;

    try {
        const pool = await getPool();

        let query = `
            SELECT SupplierID, Documents, Experiences, CreatedAt, UpdateDate
            FROM SupplierProfile
            WHERE ProfileStatusID IN ('PS002', 'PS001')
        `;

        if (lastSyncDate) {
            query += ` AND (CreatedAt > @lastSyncDate OR UpdateDate > @lastSyncDate)`;
        }

        query += ` ORDER BY CreatedAt DESC`;

        const request = pool.request();
        if (lastSyncDate) {
            request.input('lastSyncDate', sql.DateTime, lastSyncDate);
        }

        const result = await request.query(query);

        res.json({
            success: true,
            documents: result.recordset,
            count: result.recordset.length
        });

    } catch (err) {
        console.error('[GET /api/sync/suppliers/documents] Error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ── PATCH /api/sync/suppliers/:supplierId/documents/:docType/status ──
// Returns only the changed document info, not the whole Documents array.
router.patch('/suppliers/:supplierId/documents/:docType/status', async (req, res) => {
    const t0 = Date.now();
    const tag = `[doc-status ${req.params.supplierId}/${req.params.docType}]`;
    console.log(`${tag} START`);

    res.on('close', () => {
        console.log(`${tag} CLOSE after ${Date.now() - t0}ms, replyFinished=${res.writableFinished}`);
    });

    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { supplierId, docType } = req.params;
    const { status, rejectionReason } = req.body;

    if (!['Verified', 'Rejected'].includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status. Must be Verified or Rejected.' });
    }

    try {
        const pool = await getPool();
        console.log(`${tag} pool ready +${Date.now() - t0}ms`);

        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        console.log(`${tag} tx begun +${Date.now() - t0}ms`);

        try {
            const result = await transaction.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`
                    SELECT Documents
                    FROM SupplierProfile WITH (UPDLOCK, HOLDLOCK)
                    WHERE SupplierID = @supplierId
                `);
            console.log(`${tag} row locked +${Date.now() - t0}ms`);

            if (result.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({ success: false, message: 'Supplier not found' });
            }

            let documents = result.recordset[0].Documents
                ? JSON.parse(result.recordset[0].Documents)
                : [];

            const verifiedAt = new Date().toISOString();
            let updatedCount = 0;

            documents = documents.map(doc => {
                if (doc.docType === docType && doc.status === 'Pending') {
                    updatedCount++;
                    return {
                        ...doc,
                        status,
                        rejectionReason: status === 'Rejected' ? rejectionReason : undefined,
                        verifiedAt
                    };
                }
                return doc;
            });

            const documentsJson = JSON.stringify(documents);

            await transaction.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .input('documents', sql.NVarChar(sql.MAX), documentsJson)
                .query(`UPDATE SupplierProfile SET Documents = @documents WHERE SupplierID = @supplierId`);

            await transaction.commit();
            console.log(`${tag} committed +${Date.now() - t0}ms, stored=${documentsJson.length} chars, updatedCount=${updatedCount}`);

            res.json({
                success: true,
                message: `Document ${status.toLowerCase()} successfully`,
                docType,
                status,
                rejectionReason: status === 'Rejected' ? rejectionReason : null,
                verifiedAt,
                updatedCount
            });
            console.log(`${tag} res.json called +${Date.now() - t0}ms`);
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error(`${tag} ERROR +${Date.now() - t0}ms:`, err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// ── PATCH /api/sync/suppliers/:supplierId/experiences/:index/status ──
router.patch('/suppliers/:supplierId/experiences/:index/status', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { supplierId, index } = req.params;
    const { status, rejectionReason } = req.body;
    const expIndex = parseInt(index, 10);

    if (!['Verified', 'Rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be Verified or Rejected.' });
    }
    if (isNaN(expIndex) || expIndex < 0) {
        return res.status(400).json({ message: 'Invalid experience index.' });
    }

    try {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const result = await transaction.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`
                    SELECT Experiences
                    FROM SupplierProfile WITH (UPDLOCK, HOLDLOCK)
                    WHERE SupplierID = @supplierId
                `);

            if (result.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({ message: 'Supplier not found' });
            }

            let experiences = result.recordset[0].Experiences ? JSON.parse(result.recordset[0].Experiences) : [];
            if (expIndex >= experiences.length) {
                await transaction.rollback();
                return res.status(404).json({ message: 'Experience not found at that index' });
            }

            experiences[expIndex] = {
                ...experiences[expIndex],
                status,
                rejectionReason: status === 'Rejected' ? (rejectionReason || null) : undefined,
                verifiedAt: new Date().toISOString(),
            };

            await transaction.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .input('experiences', sql.NVarChar(sql.MAX), JSON.stringify(experiences))
                .query(`UPDATE SupplierProfile SET Experiences = @experiences WHERE SupplierID = @supplierId`);

            await transaction.commit();

            res.json({
                success: true,
                message: `Experience ${status.toLowerCase()} successfully`,
                experiences: JSON.stringify(experiences)
            });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error('[PATCH /api/sync/suppliers/:id/experiences/:index/status] Error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── GET /api/sync/interests ──

router.get('/interests', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { lastSyncDate, tenderId } = req.query;

    let since = null;
    if (lastSyncDate) {
        since = new Date(lastSyncDate);
        if (isNaN(since.getTime())) {
            return res.status(400).json({ success: false, message: 'Invalid lastSyncDate' });
        }
    }

    if (tenderId !== undefined && (typeof tenderId !== 'string' || tenderId.length > 50)) {
        return res.status(400).json({ success: false, message: 'Invalid tenderId' });
    }

    try {
        const pool = await getPool();

        let query = `
            SELECT
                i.TenderID,
                i.SupplierID,
                i.InterestDate,
                sp.CompanyName,
                sp.RegistrationNumber,
                sp.ContactPerson,
                sp.Email,
                sp.Phone
            FROM Interests i
            INNER JOIN SupplierProfile sp ON sp.SupplierID = i.SupplierID
            WHERE 1 = 1
        `;

        const request = pool.request();

        if (since) {
            query += ` AND i.InterestDate >= @since`;
            request.input('since', sql.Date, since);
        }

        if (tenderId) {
            query += ` AND i.TenderID = @tenderId`;
            request.input('tenderId', sql.VarChar(50), tenderId);
        }

        query += ` ORDER BY i.InterestDate DESC, i.TenderID ASC`;

        const result = await request.query(query);

        res.json({
            success: true,
            interests: result.recordset,
            count: result.recordset.length
        });
    } catch (err) {
        console.error('[GET /api/sync/interests] Error:', err);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});


// ── GET /api/sync/bids ──
router.get('/bids', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!process.env.SYNC_API_KEY || !safeEqual(apiKey, process.env.SYNC_API_KEY)) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    // ── Validate inputs ──
    let since = null;
    if (req.query.lastSyncDate) {
        since = new Date(req.query.lastSyncDate);
        if (isNaN(since.getTime())) {
            return res.status(400).json({ success: false, message: 'Invalid lastSyncDate' });
        }
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 1000);

    try {
        const pool = await getPool();

        // ── Page of bids (fetch limit + 1 to know if more exist) ──
        const request = pool.request();
        request.input('limit', sql.Int, limit + 1);

        let query = `
            SELECT TOP (@limit)
                b.BidID, b.TenderID, b.SupplierID,
                b.SubmittedDate, b.GrandTotal, b.BidStatusID,
                b.CreatedAt
            FROM Bid b
            WHERE 1 = 1
        `;
        if (since) {
            request.input('lastSyncDate', sql.DateTime2, since);
            query += ` AND b.CreatedAt > @lastSyncDate`;
        }
        query += ` ORDER BY b.CreatedAt ASC, b.BidID ASC`;

        const bidsRes = await request.query(query);
        const hasMore = bidsRes.recordset.length > limit;
        const bids = hasMore ? bidsRes.recordset.slice(0, limit) : bidsRes.recordset;

        if (bids.length === 0) {
            return res.json({ success: true, bids: [], count: 0, hasMore: false, nextCursor: null });
        }

        // ── Items for this page only (<= 1000 params, under the 2100 cap) ──
        const itemsReq = pool.request();
        const placeholders = bids.map((b, i) => {
            itemsReq.input(`bid${i}`, sql.VarChar(50), b.BidID);
            return `@bid${i}`;
        }).join(',');

        const itemsRes = await itemsReq.query(`
            SELECT
                bi.BidID, bi.ItemNo, bi.TenderItemID,
                bi.Quantity, bi.UnitPrice, bi.Total,
                bi.CountryOfOrigin, bi.PackSize, bi.ExpiryDate,
                ti.DrugID
            FROM BidItem bi
            LEFT JOIN TenderItem ti ON bi.TenderItemID = ti.TenderItemID
            WHERE bi.BidID IN (${placeholders})
            ORDER BY bi.BidID, bi.ItemNo ASC
        `);

        const itemMap = {};
        itemsRes.recordset.forEach(row => {
            (itemMap[row.BidID] = itemMap[row.BidID] || []).push({
                itemNo:          row.ItemNo,
                tenderItemId:    row.TenderItemID,
                drugId:          row.DrugID,      // null if TenderItem is missing
                quantity:        row.Quantity,
                unitPrice:       row.UnitPrice,
                total:           row.Total,
                countryOfOrigin: row.CountryOfOrigin || null,
                packSize:        row.PackSize || null,
                // SQL DATE -> plain YYYY-MM-DD string (no timezone shift for HMS)
                expiryDate:      row.ExpiryDate
                                    ? new Date(row.ExpiryDate).toISOString().slice(0, 10)
                                    : null,
            });
        });
        bids.forEach(b => { b.items = itemMap[b.BidID] || []; });

        const last = bids[bids.length - 1];
        res.json({
            success: true,
            bids,
            count: bids.length,
            hasMore,
            nextCursor: last.CreatedAt,
        });
    } catch (err) {
        console.error('[GET /api/sync/bids] Error:', err);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

module.exports = router;