// routes/notification.routes.js
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { getPool, sql } = require('../db/procurement');
const { getSupplierUserId } = require('../helpers/notifications');


async function resolveOwnerUserId(pool, reqUser) {
    if (reqUser.role === 'supplier') {
        return await getSupplierUserId(pool, reqUser.userId); // userId here is SupplierID
    }
    return reqUser.userId; // admin: already the SystemUser.UserID
}

// GET /api/notifications/:userId  — get all notifications for a user (own only)
router.get('/:userId', requireAuth, async (req, res) => {
    try {
        const pool    = await getPool();
        const ownerId = await resolveOwnerUserId(pool, req.user);

        if (!ownerId) return res.json([]);

        const result = await pool.request()
            .input('userId', sql.VarChar(50), ownerId)
            .query(`
                SELECT
                    n.NotificationID AS id, n.Message AS message,
                    nt.NotificationTypeName AS type,
                    n.Timestamp AS timestamp, n.IsRead AS [read], n.Link AS link
                FROM Notifications n
                JOIN NotificationType nt ON n.NotificationTypeID = nt.NotificationTypeID
                WHERE n.UserID = @userId ORDER BY n.Timestamp DESC
            `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET notifications] Error:', error);
        res.json([]);
    }
});

// PATCH /api/notifications/:id/read  — mark a single notification read (own only)
router.patch('/:id/read', requireAuth, async (req, res) => {
    const { id } = req.params;
    try {
        const pool    = await getPool();
        const ownerId = await resolveOwnerUserId(pool, req.user);

        if (!ownerId) return res.status(404).json({ message: 'Notification not found' });

        const result = await pool.request()
            .input('notificationId', sql.VarChar(50), id)
            .input('userId',         sql.VarChar(50), ownerId)
            .query(`
                UPDATE Notifications SET IsRead = 1
                WHERE NotificationID = @notificationId AND UserID = @userId
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Notification not found' });

        res.json({ message: 'Notification marked as read' });
    } catch (error) {
        console.error('[PATCH notification read] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// PATCH /api/notifications/read-all  — mark all of the user's notifications read
router.patch('/read-all', requireAuth, async (req, res) => {
    try {
        const pool    = await getPool();
        const ownerId = await resolveOwnerUserId(pool, req.user);

        if (!ownerId) return res.json({ message: 'No notifications to update' });

        await pool.request()
            .input('userId', sql.VarChar(50), ownerId)
            .query(`UPDATE Notifications SET IsRead = 1 WHERE UserID = @userId AND IsRead = 0`);

        res.json({ message: 'All notifications marked as read' });
    } catch (error) {
        console.error('[PATCH notifications read-all] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;
