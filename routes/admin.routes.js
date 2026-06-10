// routes/admin.routes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth');
const { getPool, sql } = require('../db/procurement');
const { generateId } = require('../utils/idGenerator');
const { logAudit } = require('../helpers/audit');

// ── GET /api/admin/users admin: list all admin users with status and last login 

router.get('/users', requireAdmin, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT
                ap.AdminID        AS id,
                ap.Name           AS name,
                su.Email          AS email,
                ap.Role           AS role,
                su.LastLogin      AS lastLogin,
                us.UserStatusName AS status
            FROM AdminProfiles ap
            JOIN SystemUser su ON ap.AdminID      = su.AdminID
            JOIN UserStatus us ON su.UserStatusID = us.UserStatusID
            WHERE su.Role = 'admin'
            ORDER BY ap.CreateDate DESC
        `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET /api/admin/users] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── POST /api/admin/users admin: create new admin user (also creates SystemUser with IsFirstLogin=1)
router.post('/users', requireAdmin, async (req, res) => {
    const { name, email, role, password } = req.body;
    if (!name || !email || !role || !password)
        return res.status(400).json({ message: 'All fields are required' });

    try {
        const pool = await getPool();
        const existing = await pool.request()
            .input('email', sql.VarChar(255), email)
            .query(`SELECT Email FROM SystemUser WHERE Email = @email`);

        if (existing.recordset.length > 0)
            return res.status(400).json({ message: 'User already exists' });

        const adminId        = generateId('ADM');
        const userId         = generateId('USR');
        const hashedPassword = await bcrypt.hash(password, 10);

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            await transaction.request()
                .input('adminId',      sql.VarChar(50),   adminId)
                .input('name',         sql.NVarChar(255), name)
                .input('email',        sql.VarChar(255),  email)
                .input('role',         sql.NVarChar(50),  role)
                .input('userStatusId', sql.VarChar(20),   'UST001')
                .query(`
                    INSERT INTO AdminProfiles
                        (AdminID, Name, Email, Role, UserStatusID, CreateDate)
                    VALUES
                        (@adminId, @name, @email, @role, @userStatusId, GETDATE())
                `);

            // IsFirstLogin = 1 so newly-created admins are prompted to change
            // their password on first login, and cannot access other endpoints until they do.
            await transaction.request()
                .input('userId',       sql.VarChar(50),  userId)
                .input('email',        sql.VarChar(255), email)
                .input('passwordHash', sql.VarChar(255), hashedPassword)
                .input('role',         sql.VarChar(20),  'admin')
                .input('adminId',      sql.VarChar(50),  adminId)
                .input('userStatusId', sql.VarChar(20),  'UST001')
                .query(`
                    INSERT INTO SystemUser
                        (UserID, Email, PasswordHash, Role, AdminID, UserStatusID, IsFirstLogin, CreateDate)
                    VALUES
                        (@userId, @email, @passwordHash, @role, @adminId, @userStatusId, 1, GETDATE())
                `);

            await transaction.commit();

            await logAudit(pool, req, {
                action: 'ADMIN_USER_CREATE', entityType: 'AdminUser', entityId: adminId,
                description: `Created admin user ${name} (${email}), role: ${role}`,
            });

            res.status(201).json({ id: adminId, name, email, role, lastLogin: null, status: 'Active' });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('[POST /api/admin/users] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── DELETE /api/admin/users/:id admin: delete admin user (also deletes SystemUser)
router.delete('/users/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const pool  = await getPool();
        const check = await pool.request()
            .input('adminId', sql.VarChar(50), id)
            .query(`SELECT AdminID FROM AdminProfiles WHERE AdminID = @adminId`);

        if (check.recordset.length === 0)
            return res.status(404).json({ message: 'User not found' });

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            await transaction.request()
                .input('adminId', sql.VarChar(50), id)
                .query(`DELETE FROM SystemUser WHERE AdminID = @adminId`);

            await transaction.request()
                .input('adminId', sql.VarChar(50), id)
                .query(`DELETE FROM AdminProfiles WHERE AdminID = @adminId`);

            await transaction.commit();

            await logAudit(pool, req, {
                action: 'ADMIN_USER_DELETE', entityType: 'AdminUser', entityId: id,
                description: `Deleted admin user ${id}`,
            });

            res.json({ message: 'User deleted successfully' });
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('[DELETE /api/admin/users/:id] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/admin/update-tender-statuses 
router.get('/update-tender-statuses', requireAdmin, async (req, res) => {
    try {
        const pool  = await getPool();
        const today = new Date().toISOString().split('T')[0];

        const openResult = await pool.request()
            .input('today', sql.Date, today)
            .query(`
                UPDATE Tender
                SET TenderStatusID = 'TS002', UpdatedAt = GETDATE()
                WHERE TenderStatusID = 'TS001'
                  AND OpeningDate <= @today
                  AND ClosingDate  >  @today
            `);

        const closeResult = await pool.request()
            .input('today', sql.Date, today)
            .query(`
                UPDATE Tender
                SET TenderStatusID = 'TS003', UpdatedAt = GETDATE()
                WHERE TenderStatusID = 'TS002'
                  AND ClosingDate < @today
            `);

        res.json({
            message:   'Tender statuses updated',
            opened:    openResult.rowsAffected[0],
            closed:    closeResult.rowsAffected[0],
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[update-tender-statuses] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/admin/check-closing-tenders 
router.get('/check-closing-tenders', requireAdmin, async (req, res) => {
    try {
        const pool  = await getPool();
        const today = new Date();
        const in3   = new Date();
        in3.setDate(today.getDate() + 3);

        const result = await pool.request()
            .input('today',     sql.Date, today.toISOString().split('T')[0])
            .input('threeDays', sql.Date, in3.toISOString().split('T')[0])
            .query(`
                SELECT
                    t.TenderID              AS tenderid,
                    t.Title,
                    t.ClosingDate           AS closingdate,
                    t.CategoryID,
                    tc.TenderCategoryName   AS categoryname
                FROM Tender t
                JOIN TenderCategory tc ON t.CategoryID = tc.TenderCategoryID
                WHERE t.TenderStatusID = 'TS002'
                  AND t.ClosingDate BETWEEN @today AND @threeDays
            `);

        res.json({
            message:          `Found ${result.recordset.length} tenders closing soon`,
            count:            result.recordset.length,
            newNotifications: 0,
            tenders:          result.recordset
        });
    } catch (error) {
        console.error('[check-closing-tenders] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/admin/check-expiring-documents 
router.get('/check-expiring-documents', requireAdmin, async (req, res) => {
    try {
        const pool   = await getPool();
        const result = await pool.request().query(`
            SELECT SupplierID, CompanyName, Email, Documents
            FROM SupplierProfile
            WHERE Documents IS NOT NULL AND Documents != '[]'
        `);

        const today             = new Date();
        const expiringDocuments = [];

        for (const supplier of result.recordset) {
            const documents = JSON.parse(supplier.Documents || '[]');
            for (const doc of documents) {
                if (doc.expiryDate && doc.requiresExpiry && doc.status !== 'Replaced') {
                    const daysUntilExpiry = Math.ceil(
                        (new Date(doc.expiryDate) - today) / 86_400_000
                    );
                    if (daysUntilExpiry <= 30) {
                        expiringDocuments.push({
                            supplierId:   supplier.SupplierID,
                            supplierName: supplier.CompanyName,
                            documentName: doc.name,
                            expiryDate:   doc.expiryDate,
                            daysUntilExpiry
                        });
                    }
                }
            }
        }

        res.json({
            message:           'Document expiry check completed',
            expiringCount:     expiringDocuments.length,
            notificationsSent: expiringDocuments.length,
            expiringDocuments
        });
    } catch (error) {
        console.error('[check-expiring-documents] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;