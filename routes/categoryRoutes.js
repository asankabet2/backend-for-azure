// routes/categoryRoutes.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/procurement');
const { verifyAdmin } = require('../middleware/auth');
const IDGenerator = require('../utils/idGenerator');
const { logAudit } = require('../helpers/audit');

// GET /api/categories - Public (active only)
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('statusId', sql.VarChar(10), 'C001')
            .query(`
                SELECT TenderCategoryID AS id, TenderCategoryName AS name,
                       ISNULL(Description,'') AS description
                FROM TenderCategory
                WHERE TenderCategoryStatusID = @statusId
                ORDER BY TenderCategoryName ASC
            `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /api/categories] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/categories/all - Admin only
router.get('/all', verifyAdmin, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT 
                TenderCategoryID AS categoryid, 
                TenderCategoryName AS categoryname,
                ISNULL(Description,'') AS description, 
                TenderCategoryStatusID AS statusid
            FROM TenderCategory 
            ORDER BY TenderCategoryName ASC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /api/categories/all] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST /api/categories - Create new category (admin only)
router.post('/', verifyAdmin, async (req, res) => {
    const { name, description } = req.body;
    
    if (!name || !name.trim()) {
        return res.status(400).json({ message: 'Category name is required' });
    }
    
    try {
        const pool = await getPool();
        const categoryId = await IDGenerator.generateCategoryId();
        
        const existing = await pool.request()
            .input('name', sql.NVarChar(100), name.trim())
            .query(`SELECT TenderCategoryID FROM TenderCategory WHERE TenderCategoryName = @name`);
        
        if (existing.recordset.length > 0) {
            return res.status(400).json({ message: 'Category already exists' });
        }
        
        await pool.request()
            .input('categoryId', sql.VarChar(20), categoryId)
            .input('name', sql.NVarChar(100), name.trim())
            .input('description', sql.NVarChar(sql.MAX), description || '')
            .input('statusId', sql.VarChar(10), 'C001')
            .query(`
                INSERT INTO TenderCategory (TenderCategoryID, TenderCategoryName, Description, TenderCategoryStatusID)
                VALUES (@categoryId, @name, @description, @statusId)
            `);
        
        await logAudit(pool, req, {
            action: 'CATEGORY_CREATE', entityType: 'Category', entityId: categoryId,
            description: `Created tender category "${name.trim()}"`,
        });

        res.status(201).json({
            id: categoryId,
            categoryid: categoryId,
            name: name.trim(),
            categoryname: name.trim(),
            description: description || '',
            statusid: 'C001'
        });
    } catch (error) {
        console.error('[POST /api/categories] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// DELETE /api/categories/:id - Deactivate category (admin only)
router.delete('/:id', verifyAdmin, async (req, res) => {
    const { id } = req.params;
    
    try {
        const pool = await getPool();
        
        const existing = await pool.request()
            .input('categoryId', sql.VarChar(20), id)
            .query(`SELECT TenderCategoryID FROM TenderCategory WHERE TenderCategoryID = @categoryId`);
        
        if (existing.recordset.length === 0) {
            return res.status(404).json({ message: 'Category not found' });
        }
        
        const inUse = await pool.request()
            .input('categoryId', sql.VarChar(20), id)
            .query(`
                SELECT COUNT(*) as count 
                FROM Tender 
                WHERE CategoryID = @categoryId 
                AND TenderStatusID != 'TS003'
            `);
        
        if (inUse.recordset[0].count > 0) {
            return res.status(400).json({ message: 'Cannot deactivate category that is used in active tenders' });
        }
        
        await pool.request()
            .input('categoryId', sql.VarChar(20), id)
            .query(`UPDATE TenderCategory SET TenderCategoryStatusID = 'C002' WHERE TenderCategoryID = @categoryId`);

        await logAudit(pool, req, {
            action: 'CATEGORY_DEACTIVATE', entityType: 'Category', entityId: id,
            description: `Deactivated tender category ${id}`,
        });

        res.json({ message: 'Category deactivated successfully' });
    } catch (error) {
        console.error('[DELETE /api/categories/:id] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// POST /api/categories/:id/restore - Restore category (admin only)
router.post('/:id/restore', verifyAdmin, async (req, res) => {
    const { id } = req.params;
    
    try {
        const pool = await getPool();
        
        const existing = await pool.request()
            .input('categoryId', sql.VarChar(20), id)
            .query(`SELECT TenderCategoryID FROM TenderCategory WHERE TenderCategoryID = @categoryId`);
        
        if (existing.recordset.length === 0) {
            return res.status(404).json({ message: 'Category not found' });
        }
        
        await pool.request()
            .input('categoryId', sql.VarChar(20), id)
            .query(`UPDATE TenderCategory SET TenderCategoryStatusID = 'C001' WHERE TenderCategoryID = @categoryId`);

        await logAudit(pool, req, {
            action: 'CATEGORY_RESTORE', entityType: 'Category', entityId: id,
            description: `Restored tender category ${id}`,
        });

        res.json({ message: 'Category restored successfully' });
    } catch (error) {
        console.error('[POST /api/categories/:id/restore] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;