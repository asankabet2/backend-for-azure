'use strict';

const express = require('express');
const router = express.Router();
const { mapTenderStatus } = require('../helpers/tenderHelpers');
const { getPool, sql } = require('../db/procurement');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

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
router.post('/tenders', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

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
        console.error('[POST /api/sync/tenders] Error:', err);
        res.status(500).json({ message: err.message });
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
// Separate from /api/sync/suppliers - returns just SupplierID + the Documents/Experiences
// JSON blobs, filtered the same way (CreatedAt/UpdateDate vs lastSyncDate).
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
router.patch('/suppliers/:supplierId/documents/:docType/status', async (req, res) => {
    const apiKey = req.headers['x-sync-api-key'];
    if (!apiKey || apiKey !== process.env.SYNC_API_KEY) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    const { supplierId, docType } = req.params;
    const { status, rejectionReason } = req.body;

    if (!['Verified', 'Rejected'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status. Must be Verified or Rejected.' });
    }

    try {
        const pool = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const result = await transaction.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`
                    SELECT Documents
                    FROM SupplierProfile WITH (UPDLOCK, HOLDLOCK)
                    WHERE SupplierID = @supplierId
                `);

            if (result.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({ message: 'Supplier not found' });
            }

            let documents = result.recordset[0].Documents
                ? JSON.parse(result.recordset[0].Documents)
                : [];

            documents = documents.map(doc =>
                (doc.docType === docType && doc.status === 'Pending')
                    ? { ...doc, status, rejectionReason: status === 'Rejected' ? rejectionReason : undefined, verifiedAt: new Date().toISOString() }
                    : doc
            );

            await transaction.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .input('documents', sql.NVarChar(sql.MAX), JSON.stringify(documents))
                .query(`UPDATE SupplierProfile SET Documents = @documents WHERE SupplierID = @supplierId`);

            await transaction.commit();

            res.json({
                success: true,
                message: `Document ${status.toLowerCase()} successfully`,
                documents: JSON.stringify(documents)
            });
        } catch (err) {
            await transaction.rollback();
            throw err;
        }
    } catch (err) {
        console.error('[PATCH /api/sync/suppliers/:id/documents/:docType/status] Error:', err);
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

module.exports = router;