// routes/auth.routes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { getPool, sql } = require('../db/procurement');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { generateId } = require('../utils/idGenerator');
const { logAudit } = require('../helpers/audit');

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { message: 'Too many login attempts. Please try again in 15 minutes.' }
});

// ============ ADMIN LOGIN ============
router.post('/admin/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('email', sql.VarChar(255), email)
            .input('role', sql.VarChar(20), 'admin')
            .query(`
                SELECT
                    su.UserID, su.Email, su.PasswordHash, su.AdminID,
                    ap.Name, ap.Role AS AdminRole,
                    us.UserStatusName AS Status,
                    ISNULL(su.IsFirstLogin, 0) AS IsFirstLogin
                FROM SystemUser su
                JOIN AdminProfiles ap ON su.AdminID = ap.AdminID
                JOIN UserStatus us ON su.UserStatusID = us.UserStatusID
                WHERE su.Email = @email AND su.Role = @role
            `);

        if (result.recordset.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const user = result.recordset[0];

        if (user.Status !== 'Active') {
            return res.status(403).json({ message: 'Account is not active' });
        }

        const isValid = await bcrypt.compare(password, user.PasswordHash);
        if (!isValid) {
            await logAudit(pool, req, {
                action: 'LOGIN_FAILED', entityType: 'Auth', entityId: user.UserID,
                description: `Failed admin login (wrong password) for ${email}`,
                actor: { userId: user.UserID, role: 'admin', email: user.Email },
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.UserID, adminId: user.AdminID, role: 'admin', email: user.Email },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        await pool.request()
            .input('userId', sql.VarChar(50), user.UserID)
            .query(`UPDATE SystemUser SET LastLogin = GETDATE() WHERE UserID = @userId`);

        await logAudit(pool, req, {
            action: 'LOGIN_SUCCESS', entityType: 'Auth', entityId: user.UserID,
            description: `Admin ${user.Email} logged in`,
            actor: { userId: user.UserID, role: 'admin', email: user.Email },
        });

        res.json({
            message: 'Login successful',
            user: { id: user.UserID, adminId: user.AdminID, name: user.Name, email: user.Email, role: 'admin' },
            token,
            requiresPasswordChange: user.IsFirstLogin === 1 || user.IsFirstLogin === true
        });
    } catch (error) {
        console.error('[Admin Login] Error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ============ SUPPLIER LOGIN ============
router.post('/supplier/login', loginLimiter, async (req, res) => {
    const { email, password } = req.body;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('email', sql.VarChar(255), email)
            .input('role', sql.VarChar(20), 'supplier')
            .query(`
                SELECT
                    su.UserID, su.Email, su.PasswordHash, su.SupplierID,
                    sp.CompanyName, sp.ContactPerson, sp.ProfileStatusID,
                    ps.ProfileStatusName AS Status,
                    us.UserStatusName AS UserStatus,
                    ISNULL(su.IsFirstLogin, 1) AS IsFirstLogin
                FROM SystemUser su
                JOIN SupplierProfile sp ON su.SupplierID = sp.SupplierID
                JOIN ProfileStatus ps ON sp.ProfileStatusID = ps.ProfileStatusID
                JOIN UserStatus us ON su.UserStatusID = us.UserStatusID
                WHERE su.Email = @email AND su.Role = @role
            `);

        if (result.recordset.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const user = result.recordset[0];

        if (user.UserStatus !== 'Active') {
            return res.status(403).json({ message: 'Account is not active' });
        }

        if (user.Status !== 'Approved') {
            return res.status(403).json({ message: 'Account not approved yet. Please wait for admin approval.' });
        }

        const isValid = await bcrypt.compare(password, user.PasswordHash);
        if (!isValid) {
            await logAudit(pool, req, {
                action: 'LOGIN_FAILED', entityType: 'Auth', entityId: user.SupplierID,
                description: `Failed supplier login (wrong password) for ${email}`,
                actor: { userId: user.SupplierID, role: 'supplier', email: user.Email },
            });
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { userId: user.SupplierID, role: 'supplier', email: user.Email, companyName: user.CompanyName },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        await pool.request()
            .input('userId', sql.VarChar(50), user.UserID)
            .query(`UPDATE SystemUser SET LastLogin = GETDATE() WHERE UserID = @userId`);

        await logAudit(pool, req, {
            action: 'LOGIN_SUCCESS', entityType: 'Auth', entityId: user.SupplierID,
            description: `Supplier ${user.CompanyName || user.Email} logged in`,
            actor: { userId: user.SupplierID, role: 'supplier', email: user.Email },
        });

        res.json({
            message: 'Login successful',
            user: {
                id: user.SupplierID,
                name: user.ContactPerson || user.CompanyName,
                companyName: user.CompanyName,
                email: user.Email,
                role: 'supplier'
            },
            token,
            requiresPasswordChange: user.IsFirstLogin === 1 || user.IsFirstLogin === true
        });
    } catch (error) {
        console.error('[Supplier Login] Error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// ============ CHANGE PASSWORD ============
router.post('/change-password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }

    const { role } = req.user;

    try {
        const pool = await getPool();

        if (role === 'admin') {
            const adminId = req.user.adminId;
            if (!adminId) {
                return res.status(400).json({ message: 'Token is missing adminId claim — please log in again' });
            }

            const result = await pool.request()
                .input('adminId', sql.VarChar(50), adminId)
                .query(`SELECT PasswordHash, IsFirstLogin FROM SystemUser WHERE AdminID = @adminId AND Role = 'admin'`);

            if (result.recordset.length === 0) {
                return res.status(404).json({ message: 'Admin user not found' });
            }

            const userRow = result.recordset[0];
            const isFirstLogin = userRow.IsFirstLogin === 1 || userRow.IsFirstLogin === true;

            if (!isFirstLogin) {
                if (!currentPassword) {
                    return res.status(400).json({ message: 'Current password is required' });
                }
                const isValid = await bcrypt.compare(currentPassword, userRow.PasswordHash);
                if (!isValid) {
                    return res.status(401).json({ message: 'Current password is incorrect' });
                }
            }

            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await pool.request()
                .input('adminId', sql.VarChar(50), adminId)
                .input('passwordHash', sql.VarChar(255), hashedPassword)
                .query(`UPDATE SystemUser SET PasswordHash = @passwordHash, IsFirstLogin = 0 WHERE AdminID = @adminId AND Role = 'admin'`);

        } else {
            const supplierId = req.user.userId;
            const result = await pool.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`SELECT PasswordHash, IsFirstLogin FROM SystemUser WHERE SupplierID = @supplierId AND Role = 'supplier'`);

            if (result.recordset.length === 0) {
                return res.status(404).json({ message: 'Supplier user not found' });
            }

            const userRow = result.recordset[0];
            const isFirstLogin = userRow.IsFirstLogin === 1 || userRow.IsFirstLogin === true;

            if (!isFirstLogin) {
                if (!currentPassword) {
                    return res.status(400).json({ message: 'Current password is required' });
                }
                const isValid = await bcrypt.compare(currentPassword, userRow.PasswordHash);
                if (!isValid) {
                    return res.status(401).json({ message: 'Current password is incorrect' });
                }
            }

            const hashedPassword = await bcrypt.hash(newPassword, 10);
            await pool.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .input('passwordHash', sql.VarChar(255), hashedPassword)
                .query(`UPDATE SystemUser SET PasswordHash = @passwordHash, IsFirstLogin = 0 WHERE SupplierID = @supplierId AND Role = 'supplier'`);
        }

        await logAudit(pool, req, {
            action: 'PASSWORD_CHANGE', entityType: 'Auth', entityId: req.user.userId,
            description: `${role === 'admin' ? 'Admin' : 'Supplier'} ${req.user.email} changed their password`,
        });

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('[Change Password] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ============ FORGOT PASSWORD ============
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('email', sql.VarChar(255), email)
            .query(`SELECT UserID, Role FROM SystemUser WHERE Email = @email`);

        if (result.recordset.length === 0) {
            return res.json({ message: 'If an account exists for that email, a reset link has been sent' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpiry = new Date();
        resetExpiry.setHours(resetExpiry.getHours() + 1);

        await pool.request()
            .input('email', sql.VarChar(255), email)
            .input('token', sql.NVarChar(255), resetToken)
            .input('expiry', sql.DateTime, resetExpiry)
            .query(`UPDATE SystemUser SET PasswordResetToken = @token, PasswordResetExpiry = @expiry WHERE Email = @email`);

        res.json({
            message: 'If an account exists for that email, a reset link has been sent',
            ...(process.env.NODE_ENV !== 'production' && { resetToken })
        });
    } catch (error) {
        console.error('[Forgot Password] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ============ RESET PASSWORD ============
router.post('/reset-password', async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ message: 'Token and new password are required' });
    }
    if (newPassword.length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('token', sql.NVarChar(255), token)
            .query(`SELECT Email FROM SystemUser WHERE PasswordResetToken = @token AND PasswordResetExpiry > GETDATE()`);

        if (result.recordset.length === 0) {
            return res.status(400).json({ message: 'Invalid or expired reset token' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await pool.request()
            .input('email', sql.VarChar(255), result.recordset[0].Email)
            .input('passwordHash', sql.VarChar(255), hashedPassword)
            .query(`
                UPDATE SystemUser
                SET PasswordHash = @passwordHash,
                    PasswordResetToken = NULL,
                    PasswordResetExpiry = NULL,
                    IsFirstLogin = 0
                WHERE Email = @email
            `);

        await logAudit(pool, req, {
            action: 'PASSWORD_RESET', entityType: 'Auth',
            description: `Password reset completed for ${result.recordset[0].Email}`,
            actor: { email: result.recordset[0].Email, role: 'system' },
        });

        res.json({ message: 'Password reset successfully' });
    } catch (error) {
        console.error('[Reset Password] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ============ ADMIN CHANGE PASSWORD (backward compatibility) ============
router.post('/admin/change-password', requireAdmin, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const adminId = req.user.adminId;

    if (!adminId) {
        return res.status(400).json({ message: 'Token is missing adminId — please log in again' });
    }
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ message: 'New password must be at least 8 characters' });
    }

    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('adminId', sql.VarChar(50), adminId)
            .query(`SELECT PasswordHash, IsFirstLogin FROM SystemUser WHERE AdminID = @adminId AND Role = 'admin'`);

        if (result.recordset.length === 0) {
            return res.status(404).json({ message: 'Admin user not found' });
        }

        const userRow = result.recordset[0];
        const isFirstLogin = userRow.IsFirstLogin === 1 || userRow.IsFirstLogin === true;

        if (!isFirstLogin) {
            if (!currentPassword) {
                return res.status(400).json({ message: 'Current password is required' });
            }
            const isValid = await bcrypt.compare(currentPassword, userRow.PasswordHash);
            if (!isValid) {
                return res.status(401).json({ message: 'Current password is incorrect' });
            }
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.request()
            .input('adminId', sql.VarChar(50), adminId)
            .input('passwordHash', sql.VarChar(255), hashedPassword)
            .query(`UPDATE SystemUser SET PasswordHash = @passwordHash, IsFirstLogin = 0 WHERE AdminID = @adminId AND Role = 'admin'`);

        await logAudit(pool, req, {
            action: 'PASSWORD_CHANGE', entityType: 'Auth', entityId: req.user.userId,
            description: `Admin ${req.user.email} changed their password`,
        });

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('[Admin Change Password] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;