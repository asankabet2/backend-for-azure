// routes/stats.routes.js
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/procurement');

// GET /api/stats - Public
router.get('/', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT
                (SELECT COUNT(*) FROM Tender WHERE TenderStatusID = 'TS002') AS activeTenders,
                (SELECT COUNT(*) FROM SupplierProfile WHERE ProfileStatusID = 'PS002') AS approvedSuppliers,
                (SELECT COUNT(*) FROM Bid) AS totalBids
        `);
        res.json(result.recordset[0]);
    } catch (error) {
        console.error('[GET /api/stats] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;