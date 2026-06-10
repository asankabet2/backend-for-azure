// routes/interest.routes.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/procurement');
const { verifyAdmin } = require('../middleware/auth');

// GET /api/tenders/:id/interests - Admin only
router.get('/tenders/:id/interests', verifyAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('tenderId', sql.VarChar(50), id)
            .query(`
                SELECT i.SupplierID AS supplierId, sp.CompanyName AS supplierName,
                       i.InterestDate AS date
                FROM Interests i
                JOIN SupplierProfile sp ON i.SupplierID = sp.SupplierID
                WHERE i.TenderID = @tenderId ORDER BY i.InterestDate DESC
            `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET tender interests] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;