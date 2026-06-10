'use strict';

const express = require('express');
const router  = express.Router();
const { getPool, sql } = require('../db/procurement');
const { requireAdmin }  = require('../middleware/auth');
const { logAudit }      = require('../helpers/audit');

// ── GET /api/email-templates  — admin only ────────────────────────────────────
// Returns all templates joined with their type name.
router.get('/', requireAdmin, async (req, res) => {
    try {
        const pool   = await getPool();
        const result = await pool.request().query(`
            SELECT
                et.TemplateID,
                et.TemplateTypeID,
                ett.TemplateTypeName,
                et.Subject,
                et.Body,
                et.UpdatedAt
            FROM EmailTemplate et
            JOIN EmailTemplateType ett ON et.TemplateTypeID = ett.TemplateTypeID
            ORDER BY ett.TemplateTypeID ASC
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error('[GET /api/email-templates] Error:', err.message);
        res.status(500).json({ message: 'Failed to load email templates' });
    }
});

// ── GET /api/email-templates/types  — admin only ─────────────────────────────
router.get('/types', requireAdmin, async (req, res) => {
    try {
        const pool   = await getPool();
        const result = await pool.request().query(`
            SELECT TemplateTypeID, TemplateTypeName
            FROM EmailTemplateType
            ORDER BY TemplateTypeID ASC
        `);
        res.json(result.recordset);
    } catch (err) {
        console.error('[GET /api/email-templates/types] Error:', err.message);
        res.status(500).json({ message: 'Failed to load template types' });
    }
});

// ── POST /api/email-templates  — admin only ───────────────────────────────────
// Create a new custom email template linked to an existing template type.
router.post('/', requireAdmin, async (req, res) => {
    const { templateTypeId, subject, body } = req.body;

    if (!templateTypeId || !templateTypeId.trim())
        return res.status(400).json({ message: 'Template type is required' });
    if (!subject || !subject.trim())
        return res.status(400).json({ message: 'Subject is required' });
    if (!body || !body.trim())
        return res.status(400).json({ message: 'Body is required' });

    try {
        const pool = await getPool();

        // Verify the template type exists
        const typeCheck = await pool.request()
            .input('typeId', sql.VarChar(10), templateTypeId.trim())
            .query(`SELECT 1 FROM EmailTemplateType WHERE TemplateTypeID = @typeId`);

        if (typeCheck.recordset.length === 0)
            return res.status(404).json({ message: 'Template type not found' });

        // Only one template per type is allowed
        const existing = await pool.request()
            .input('typeId', sql.VarChar(10), templateTypeId.trim())
            .query(`SELECT TemplateID FROM EmailTemplate WHERE TemplateTypeID = @typeId`);

        if (existing.recordset.length > 0)
            return res.status(409).json({ 
                message: 'A template for this type already exists. Use the edit option to update it.',
                existingId: existing.recordset[0].TemplateID,
            });

        // Generate a new template ID
        const countRes = await pool.request()
            .query(`SELECT COUNT(*) AS total FROM EmailTemplate`);
        const nextNum    = (countRes.recordset[0].total + 1).toString().padStart(3, '0');
        const templateId = `ET${nextNum}`;

        await pool.request()
            .input('templateId',   sql.VarChar(50),       templateId)
            .input('typeId',       sql.VarChar(10),       templateTypeId.trim())
            .input('subject',      sql.NVarChar(255),     subject.trim())
            .input('body',         sql.NVarChar(sql.MAX), body.trim())
            .query(`
                INSERT INTO EmailTemplate (TemplateID, TemplateTypeID, Subject, Body, UpdatedAt)
                VALUES (@templateId, @typeId, @subject, @body, GETDATE())
            `);

        await logAudit(pool, req, {
            action:      'EMAIL_TEMPLATE_CREATE',
            entityType:  'EmailTemplate',
            entityId:    templateId,
            description: `Created email template ${templateId} for type ${templateTypeId}`,
        });

        res.status(201).json({ message: 'Template created successfully', templateId });
    } catch (err) {
        console.error('[POST /api/email-templates] Error:', err.message);
        res.status(500).json({ message: 'Failed to create email template' });
    }
});

// ── PUT /api/email-templates/:templateId  — admin only ───────────────────────
// Update the subject and body of a single template.
router.put('/:templateId', requireAdmin, async (req, res) => {
    const { templateId } = req.params;
    const { subject, body } = req.body;

    if (!subject || !subject.trim())
        return res.status(400).json({ message: 'Subject is required' });
    if (!body || !body.trim())
        return res.status(400).json({ message: 'Body is required' });

    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('templateId', sql.VarChar(50),       templateId)
            .input('subject',    sql.NVarChar(255),     subject.trim())
            .input('body',       sql.NVarChar(sql.MAX), body.trim())
            .query(`
                UPDATE EmailTemplate SET
                    Subject   = @subject,
                    Body      = @body,
                    UpdatedAt = GETDATE()
                WHERE TemplateID = @templateId
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Template not found' });

        await logAudit(pool, req, {
            action:      'EMAIL_TEMPLATE_UPDATE',
            entityType:  'EmailTemplate',
            entityId:    templateId,
            description: `Updated email template ${templateId}`,
        });

        res.json({ message: 'Template updated successfully' });
    } catch (err) {
        console.error('[PUT /api/email-templates/:templateId] Error:', err.message);
        res.status(500).json({ message: 'Failed to update email template' });
    }
});

// ── DELETE /api/email-templates/:templateId  — admin only ────────────────────
router.delete('/:templateId', requireAdmin, async (req, res) => {
    const { templateId } = req.params;
    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('templateId', sql.VarChar(50), templateId)
            .query(`DELETE FROM EmailTemplate WHERE TemplateID = @templateId`);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Template not found' });

        await logAudit(pool, req, {
            action:      'EMAIL_TEMPLATE_DELETE',
            entityType:  'EmailTemplate',
            entityId:    templateId,
            description: `Deleted email template ${templateId}`,
        });

        res.json({ message: 'Template deleted successfully' });
    } catch (err) {
        console.error('[DELETE /api/email-templates/:templateId] Error:', err.message);
        res.status(500).json({ message: 'Failed to delete email template' });
    }
});

module.exports = router;