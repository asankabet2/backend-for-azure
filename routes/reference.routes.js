// routes/reference.routes.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/procurement');

// GET /api/regions
router.get('/regions', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT RegionID AS id, RegionName AS name,
                   ISNULL(Description,'') AS description, ISNULL(KeyPrefix,'') AS keyPrefix
            FROM Regions ORDER BY RegionName ASC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /regions] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/regions/:regionId/cities
router.get('/regions/:regionId/cities', async (req, res) => {
    const { regionId } = req.params;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('regionId', sql.VarChar(20), regionId)
            .query(`
                SELECT CityID AS id, CityName AS name,
                       ISNULL(Description,'') AS description, RegionID AS regionId
                FROM Cities WHERE RegionID = @regionId ORDER BY CityName ASC
            `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /regions/:regionId/cities] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/cities
router.get('/cities', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT c.CityID AS id, c.CityName AS name,
                   ISNULL(c.Description,'') AS description,
                   c.RegionID AS regionId, r.RegionName AS regionName,
                   ISNULL(r.KeyPrefix,'') AS regionKeyPrefix
            FROM Cities c JOIN Regions r ON c.RegionID = r.RegionID
            ORDER BY c.CityName ASC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /cities] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/countries
router.get('/countries', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT CountryID AS id, CountryName AS name,
                   ISNULL(Description,'') AS description, ISNULL(KeyPrefix,'') AS keyPrefix
            FROM Countries ORDER BY CountryName ASC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /countries] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/company-types
router.get('/company-types', async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT CompanyTypeID AS id, CompanyTypeName AS name,
                   ISNULL(Description,'') AS description, ISNULL(KeyPrefix,'') AS keyPrefix
            FROM CompanyType ORDER BY CompanyTypeName ASC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /company-types] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// GET /api/registration/categories
router.get('/registration/categories', async (req, res) => {
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
        console.error('[GET /registration/categories] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;