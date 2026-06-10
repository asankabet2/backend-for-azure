
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/procurement');
const { requireAdmin } = require('../middleware/auth');
const { generateId } = require('../utils/idGenerator');
const { logAudit } = require('../helpers/audit');

function mapLibraryCriteria(r) {
    return {
        id:          r.CriteriaID,
        name:        r.Name,
        description: r.Description || '',
        maxScore:    Number(r.MaxScore) || 0,
        weight:      Number(r.Weight) || 0,
    };
}

// ── GET /api/criteria-library 
router.get('/', requireAdmin, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query(`
            SELECT CriteriaID, Name, Description, MaxScore, Weight
            FROM EvaluationCriteriaDirectory
            ORDER BY Name ASC
        `);
        res.json(result.recordset.map(mapLibraryCriteria));
    } catch (err) {
        console.error('[GET criteria-library] Error:', err.message);
        res.status(500).json({ message: 'Failed to load criteria library' });
    }
});

// ── POST /api/criteria-library 
router.post('/', requireAdmin, async (req, res) => {
    const { name, description, maxScore, weight } = req.body;
    if (!name || !name.trim())
        return res.status(400).json({ message: 'Name is required' });

    const ms = parseFloat(maxScore);
    const wt = parseFloat(weight);
    if (isNaN(ms) || ms < 0) return res.status(400).json({ message: 'Max score must be a non-negative number' });
    if (isNaN(wt) || wt < 0) return res.status(400).json({ message: 'Weight must be a non-negative number' });

    try {
        const pool = await getPool();
        const criteriaId = generateId('CLIB');

        await pool.request()
            .input('id',          sql.VarChar(50),       criteriaId)
            .input('name',        sql.NVarChar(255),     name.trim())
            .input('description', sql.NVarChar(sql.MAX), (description || '').trim())
            .input('maxScore',    sql.Decimal(9, 2),     ms)
            .input('weight',      sql.Decimal(5, 2),     wt)
            .query(`
                INSERT INTO EvaluationCriteriaDirectory (CriteriaID, Name, Description, MaxScore, Weight, CreatedAt, UpdatedAt)
                VALUES (@id, @name, @description, @maxScore, @weight, GETDATE(), GETDATE())
            `);

        await logAudit(pool, req, {
            action: 'CRITERIA_LIB_CREATE', entityType: 'Criteria', entityId: criteriaId,
            description: `Added criterion "${name.trim()}" to the library`,
        });

        res.status(201).json(mapLibraryCriteria({
            CriteriaID: criteriaId, Name: name.trim(), Description: description || '', MaxScore: ms, Weight: wt,
        }));
    } catch (err) {
        console.error('[POST criteria-library] Error:', err.message);
        res.status(500).json({ message: 'Failed to add criterion' });
    }
});

// ── PUT /api/criteria-library/:id 
router.put('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, description, maxScore, weight } = req.body;
    if (!name || !name.trim())
        return res.status(400).json({ message: 'Name is required' });

    const ms = parseFloat(maxScore);
    const wt = parseFloat(weight);
    if (isNaN(ms) || ms < 0) return res.status(400).json({ message: 'Max score must be a non-negative number' });
    if (isNaN(wt) || wt < 0) return res.status(400).json({ message: 'Weight must be a non-negative number' });

    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('id',          sql.VarChar(50),       id)
            .input('name',        sql.NVarChar(255),     name.trim())
            .input('description', sql.NVarChar(sql.MAX), (description || '').trim())
            .input('maxScore',    sql.Decimal(9, 2),     ms)
            .input('weight',      sql.Decimal(5, 2),     wt)
            .query(`
                UPDATE EvaluationCriteriaDirectory SET
                    Name = @name, Description = @description, MaxScore = @maxScore, Weight = @weight, UpdatedAt = GETDATE()
                WHERE CriteriaID = @id
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Criterion not found' });

        await logAudit(pool, req, {
            action: 'CRITERIA_LIB_UPDATE', entityType: 'Criteria', entityId: id,
            description: `Updated library criterion "${name.trim()}"`,
        });

        res.json(mapLibraryCriteria({
            CriteriaID: id, Name: name.trim(), Description: description || '', MaxScore: ms, Weight: wt,
        }));
    } catch (err) {
        console.error('[PUT criteria-library] Error:', err.message);
        res.status(500).json({ message: 'Failed to update criterion' });
    }
});

// ── DELETE /api/criteria-library/:id 
// Tenders keep their own snapshot, so removing a library entry is safe.
router.delete('/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('id', sql.VarChar(50), id)
            .query(`DELETE FROM EvaluationCriteriaDirectory WHERE CriteriaID = @id`);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Criterion not found' });

        await logAudit(pool, req, {
            action: 'CRITERIA_LIB_DELETE', entityType: 'Criteria', entityId: id,
            description: `Removed criterion ${id} from the library`,
        });

        res.json({ message: 'Criterion removed successfully' });
    } catch (err) {
        console.error('[DELETE criteria-library] Error:', err.message);
        res.status(500).json({ message: 'Failed to remove criterion' });
    }
});

module.exports = router;
