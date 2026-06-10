
const { sql } = require('../db/procurement');
const { generateId } = require('../utils/idGenerator');


function getClientIp(req) {
    if (!req) return null;
    const fwd = req.headers && req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim().slice(0, 64);
    const raw = req.ip || (req.connection && req.connection.remoteAddress) || '';
    // Normalise the IPv4-mapped IPv6 form (::ffff:127.0.0.1 -> 127.0.0.1)
    return raw.replace('::ffff:', '').slice(0, 64) || null;
}

/**
 * Record one audit entry.
 *
 * @param pool   live mssql connection pool
 * @param req    the express request (used for req.user, IP and user-agent) - may be null
 * @param opts   { action, entityType, entityId?, description?, actor? }
 */
async function logAudit(pool, req, { action, entityType = null, entityId = null, description = null, actor = null }) {
    try {
        const id = generateId('AUD');
        const u  = actor || (req && req.user) || {};
        const ip = getClientIp(req);
        const ua = req && req.headers ? (req.headers['user-agent'] || null) : null;

        await pool.request()
            .input('id',          sql.VarChar(50),   id)
            .input('userId',      sql.VarChar(50),   u.userId || null)
            .input('role',        sql.NVarChar(50),  u.role || 'system')
            .input('email',       sql.NVarChar(255), u.email || null)
            .input('action',      sql.NVarChar(100), action)
            .input('entityType',  sql.NVarChar(50),  entityType)
            .input('entityId',    sql.VarChar(50),   entityId)
            .input('description', sql.NVarChar(500), description)
            .input('ip',          sql.NVarChar(64),  ip)
            .input('ua',          sql.NVarChar(500), ua ? String(ua).slice(0, 500) : null)
            .query(`
                INSERT INTO AuditLog
                    (AuditID, UserID, UserRole, UserEmail, Action, EntityType, EntityID, Description, IPAddress, UserAgent, Timestamp)
                VALUES
                    (@id, @userId, @role, @email, @action, @entityType, @entityId, @description, @ip, @ua, GETDATE())
            `);
    } catch (err) {
        // Never let auditing break the actual operation.
        console.error('[logAudit] Error:', err.message);
    }
}

module.exports = { logAudit, getClientIp };
