'use strict';

const express = require('express');
const router = express.Router();
const { mapTenderStatus } = require('../helpers/tenderHelpers');
const { getPool, sql } = require('../db/procurement');

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

module.exports = router;