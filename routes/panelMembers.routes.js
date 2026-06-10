// routes/panelMembers.routes.js

const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/procurement');
const { requireAdmin } = require('../middleware/auth');
const { generateId } = require('../utils/idGenerator');
const { logAudit } = require('../helpers/audit');

function mapMember(r) {
    return {
        id:          r.MemberID,
        name:        r.Name,
        designation: r.Designation || '',
        department:  r.Department || '',
        email:       r.Email || '',
    };
}

// ── GET /api/panel-members 
router.get('/', requireAdmin, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT MemberID, Name, Designation, Department, Email
            FROM PanelMemberDirectory
            ORDER BY Name ASC
        `);
        res.json(result.recordset.map(mapMember));
    } catch (err) {
        console.error('[GET panel-members] Error:', err.message);
        res.status(500).json({ message: 'Failed to load panel members' });
    }
});

// ── POST /api/panel-members 
router.post('/', requireAdmin, async (req, res) => {
    const { name, designation, department, email } = req.body;
    if (!name || !name.trim())
        return res.status(400).json({ message: 'Name is required' });

    try {
        const pool = await getPool();
        const memberId = generateId('PM');

        await pool.request()
            .input('memberId',    sql.VarChar(50),   memberId)
            .input('name',        sql.NVarChar(255), name.trim())
            .input('designation', sql.NVarChar(255), (designation || '').trim())
            .input('department',  sql.NVarChar(255), (department || '').trim())
            .input('email',       sql.NVarChar(255), (email || '').trim())
            .query(`
                INSERT INTO PanelMemberDirectory (MemberID, Name, Designation, Department, Email, CreatedAt, UpdatedAt)
                VALUES (@memberId, @name, @designation, @department, @email, GETDATE(), GETDATE())
            `);

        await logAudit(pool, req, {
            action: 'DIRECTORY_MEMBER_CREATE', entityType: 'PanelMember', entityId: memberId,
            description: `Added panel member "${name.trim()}" to the directory`,
        });

        res.status(201).json(mapMember({
            MemberID: memberId, Name: name.trim(), Designation: designation || '',
            Department: department || '', Email: email || '',
        }));
    } catch (err) {
        console.error('[POST panel-members] Error:', err.message);
        res.status(500).json({ message: 'Failed to add panel member' });
    }
});

// ── PUT /api/panel-members/:id 
router.put('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, designation, department, email } = req.body;
    if (!name || !name.trim())
        return res.status(400).json({ message: 'Name is required' });

    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('id',          sql.VarChar(50),   id)
            .input('name',        sql.NVarChar(255), name.trim())
            .input('designation', sql.NVarChar(255), (designation || '').trim())
            .input('department',  sql.NVarChar(255), (department || '').trim())
            .input('email',       sql.NVarChar(255), (email || '').trim())
            .query(`
                UPDATE PanelMemberDirectory SET
                    Name = @name, Designation = @designation, Department = @department,
                    Email = @email, UpdatedAt = GETDATE()
                WHERE MemberID = @id
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Panel member not found' });

        await logAudit(pool, req, {
            action: 'DIRECTORY_MEMBER_UPDATE', entityType: 'PanelMember', entityId: id,
            description: `Updated directory panel member "${name.trim()}"`,
        });

        res.json(mapMember({
            MemberID: id, Name: name.trim(), Designation: designation || '',
            Department: department || '', Email: email || '',
        }));
    } catch (err) {
        console.error('[PUT panel-members] Error:', err.message);
        res.status(500).json({ message: 'Failed to update panel member' });
    }
});

// ── DELETE /api/panel-members/:id 
// Tenders keep their own snapshot, so removing a directory entry is safe.
router.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('id', sql.VarChar(50), id)
            .query(`DELETE FROM PanelMemberDirectory WHERE MemberID = @id`);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Panel member not found' });

        await logAudit(pool, req, {
            action: 'DIRECTORY_MEMBER_DELETE', entityType: 'PanelMember', entityId: id,
            description: `Removed panel member ${id} from the directory`,
        });

        res.json({ message: 'Panel member removed successfully' });
    } catch (err) {
        console.error('[DELETE panel-members] Error:', err.message);
        res.status(500).json({ message: 'Failed to remove panel member' });
    }
});

module.exports = router;
