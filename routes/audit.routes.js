// routes/audit.routes.js
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/procurement');
const { requireAdmin } = require('../middleware/auth');

// GET /api/audit  — admin only. Most recent entries first.

router.get('/', requireAdmin, async (req, res) => {
    try {
        const pool = await getPool();

        let limit = parseInt(req.query.limit, 10);
        if (isNaN(limit) || limit <= 0) limit = 200;
        if (limit > 1000) limit = 1000;

        const where = [];
        const request = pool.request().input('limit', sql.Int, limit);

        if (req.query.action) {
            where.push('Action = @action');
            request.input('action', sql.NVarChar(100), req.query.action);
        }
        if (req.query.entityType) {
            where.push('EntityType = @entityType');
            request.input('entityType', sql.NVarChar(50), req.query.entityType);
        }
        if (req.query.search) {
            where.push('(UserEmail LIKE @search OR Description LIKE @search OR EntityID LIKE @search)');
            request.input('search', sql.NVarChar(255), `%${req.query.search}%`);
        }

        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

        const result = await request.query(`
            SELECT TOP (@limit)
                AuditID, UserID, UserRole, UserEmail, Action,
                EntityType, EntityID, Description, IPAddress, UserAgent, Timestamp
            FROM AuditLog
            ${whereClause}
            ORDER BY Timestamp DESC
        `);

        const entries = result.recordset.map(r => ({
            id:         r.AuditID,
            user:       r.UserEmail || r.UserID || 'System',
            role:       r.UserRole,
            action:     r.Description || r.Action,
            actionCode: r.Action,
            entity:     r.EntityID ? `${r.EntityType} ${r.EntityID}` : (r.EntityType || '—'),
            entityType: r.EntityType,
            entityId:   r.EntityID,
            ip:         r.IPAddress,
            userAgent:  r.UserAgent,
            timestamp:  r.Timestamp,
        }));

        res.json(entries);
    } catch (err) {
        console.error('[GET /api/audit] Error:', err.message);
        res.status(500).json({ message: 'Failed to load audit log' });
    }
});

module.exports = router;
