// helpers/notifications.js
const { getPool, sql } = require('../db/procurement');
const { generateId } = require('../utils/idGenerator');

const NOTIFICATION_TYPES = {
    info: 'NT001',
    success: 'NT002',
    warning: 'NT003',
    error: 'NT004',
};


const ALLOWED_USER_TYPES = ['admin', 'supplier'];

async function createNotification(pool, { userId, message, type = 'info', link = '#', userType }) {
    try {
        const notifId = generateId('NOT');
        const notifTypeId = NOTIFICATION_TYPES[type] || 'NT001';

        
        let resolvedType = ALLOWED_USER_TYPES.includes(userType) ? userType : null;
        if (!resolvedType) {
            try {
                const roleRes = await pool.request()
                    .input('uid', sql.VarChar(50), userId)
                    .query(`SELECT Role FROM SystemUser WHERE UserID = @uid`);
                const role = roleRes.recordset[0]?.Role;
                resolvedType = ALLOWED_USER_TYPES.includes(role) ? role : 'supplier';
            } catch {
                resolvedType = 'supplier';
            }
        }

        await pool.request()
            .input('notifId', sql.VarChar(50), notifId)
            .input('userId', sql.VarChar(50), userId)
            .input('message', sql.NVarChar(sql.MAX), message)
            .input('typeId', sql.VarChar(20), notifTypeId)
            .input('link', sql.NVarChar(255), link)
            .input('userType', sql.NVarChar(50), resolvedType)
            .query(`
                INSERT INTO Notifications
                    (NotificationID, UserID, UserType, Message, NotificationTypeID, Timestamp, IsRead, Link)
                VALUES
                    (@notifId, @userId, @userType, @message, @typeId, GETDATE(), 0, @link)
            `);
    } catch (err) {
        console.error('[createNotification] Error:', err.message);
    }
}

async function getAdminUserIds(pool) {
    const result = await pool.request()
        .query(`SELECT UserID FROM SystemUser WHERE Role = 'admin'`);
    return result.recordset.map(r => r.UserID);
}

async function getSupplierUserId(pool, supplierId) {
    const result = await pool.request()
        .input('supplierId', sql.VarChar(50), supplierId)
        .query(`SELECT UserID FROM SystemUser WHERE SupplierID = @supplierId AND Role = 'supplier'`);
    return result.recordset[0]?.UserID || null;
}

module.exports = { createNotification, getAdminUserIds, getSupplierUserId, NOTIFICATION_TYPES };