
const express = require('express');
const router = express.Router();
const { getPool, sql } = require('../db/procurement');
const { requireAdmin } = require('../middleware/auth');
const { generateId } = require('../utils/idGenerator');
const { logAudit } = require('../helpers/audit');
const { DOCUMENT_CONFIG } = require('../config/documents');

// Parse a tender's RequiredDocuments JSON column into an array of keys.
function parseRequiredDocs(raw) {
    if (!raw) return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

// Technical evaluation: pass mark out of 100, and the authoritative weighted
// total/outcome from a scores map against the tender's selected criteria.
//   total% = Σ((score/maxScore) * weight) / Σweight * 100   (weight-sum agnostic)
//   outcome: Pending until every criterion is scored, then Pass/Fail vs PASS_MARK
const TECH_PASS_MARK = 70;

function computeTechResult(criteria, scores) {
    if (!criteria.length) return { total: 0, outcome: 'Pending' };
    let weighted = 0, totalWeight = 0, allScored = true;
    for (const c of criteria) {
        totalWeight += Number(c.weight) || 0;
        const raw = scores ? scores[c.id] : undefined;
        if (raw === undefined || raw === null || raw === '') { allScored = false; continue; }
        const max = Number(c.maxScore) || 0;
        const r = Math.min(Math.max(Number(raw) || 0, 0), max);
        if (max > 0) weighted += (r / max) * (Number(c.weight) || 0);
    }
    const total = totalWeight > 0 ? (weighted / totalWeight) * 100 : 0;
    const rounded = Math.round(total * 100) / 100;
    const outcome = !allScored ? 'Pending' : (rounded >= TECH_PASS_MARK ? 'Pass' : 'Fail');
    return { total: rounded, outcome };
}

// Authoritative preliminary outcome from a results map against the required keys.
//   no required docs        -> Pass (nothing to fail administratively)
//   any required doc Failed  -> Fail
//   every required doc Pass  -> Pass
//   otherwise                -> Pending
function computePrelimOutcome(requiredKeys, results) {
    if (!requiredKeys.length) return 'Pass';
    let allPass = true;
    for (const key of requiredKeys) {
        const r = results[key];
        if (r === 'Fail') return 'Fail';
        if (r !== 'Pass') allPass = false;
    }
    return allPass ? 'Pass' : 'Pending';
}


function mapCriteria(r) {
    return {
        id:            r.CriteriaID,
        tenderId:      r.TenderID,
        criteriaRefId: r.CriteriaRefID || null,
        name:          r.CriteriaName,
        description:   r.Description || '',
        maxScore:      Number(r.MaxScore) || 0,
        weight:        Number(r.Weight) || 0,
        sortOrder:     r.SortOrder || 0,
    };
}

function mapPanelMember(r) {
    return {
        id:                r.PanelMemberID,
        tenderId:          r.TenderID,
        MemberId:          r.MemberID || null,
        name:              r.Name,
        designation:       r.Designation || '',
        department:        r.Department || '',
        role:              r.Role || 'Member',
        status:            r.Status || 'Pending',
    };
}

const PANEL_ROLES    = ['Chairperson', 'Secretary', 'Member'];
const PANEL_STATUSES = ['Pending', 'Confirmed'];

// ── GET /api/tenders/:tenderId/criteria 
router.get('/:tenderId/criteria', requireAdmin, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('tenderId', sql.VarChar(50), req.params.tenderId)
            .query(`
                SELECT CriteriaID, TenderID, CriteriaRefID, CriteriaName, Description, MaxScore, Weight, SortOrder
                FROM EvaluationCriteria
                WHERE TenderID = @tenderId
                ORDER BY SortOrder ASC, CreatedAt ASC
            `);
        res.json(result.recordset.map(mapCriteria));
    } catch (err) {
        console.error('[GET criteria] Error:', err.message);
        res.status(500).json({ message: 'Failed to load evaluation criteria' });
    }
});

// ── POST /api/tenders/:tenderId/criteria

router.post('/:tenderId/criteria', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    const { criteria } = req.body;

    if (!Array.isArray(criteria) || criteria.length === 0)
        return res.status(400).json({ message: 'Select at least one criterion to add' });

    try {
        const pool = await getPool();

        const tenderCheck = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT 1 FROM Tender WHERE TenderID = @tenderId`);
        if (tenderCheck.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        // Library criteria already on this tender — to skip duplicates.
        const existingRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT CriteriaRefID FROM EvaluationCriteria WHERE TenderID = @tenderId AND CriteriaRefID IS NOT NULL`);
        const alreadyAdded = new Set(existingRes.recordset.map(r => r.CriteriaRefID));

        let added = 0;
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            for (const c of criteria) {
                if (!c || !c.criteriaRefId || alreadyAdded.has(c.criteriaRefId)) continue;

                // Snapshot the criterion from the library.
                const lib = await transaction.request()
                    .input('id', sql.VarChar(50), c.criteriaRefId)
                    .query(`SELECT Name, Description, MaxScore, Weight FROM EvaluationCriteriaDirectory WHERE CriteriaID = @id`);
                if (lib.recordset.length === 0) continue;
                const src = lib.recordset[0];

                await transaction.request()
                    .input('criteriaId',  sql.VarChar(50),       generateId('CRIT'))
                    .input('tenderId',    sql.VarChar(50),       tenderId)
                    .input('refId',       sql.VarChar(50),       c.criteriaRefId)
                    .input('name',        sql.NVarChar(255),     src.Name)
                    .input('description', sql.NVarChar(sql.MAX), src.Description || '')
                    .input('maxScore',    sql.Decimal(9, 2),     Number(src.MaxScore) || 0)
                    .input('weight',      sql.Decimal(5, 2),     Number(src.Weight) || 0)
                    .query(`
                        INSERT INTO EvaluationCriteria
                            (CriteriaID, TenderID, CriteriaRefID, CriteriaName, Description, MaxScore, Weight, SortOrder, CreatedAt, UpdatedAt)
                        VALUES
                            (@criteriaId, @tenderId, @refId, @name, @description, @maxScore, @weight, 0, GETDATE(), GETDATE())
                    `);
                alreadyAdded.add(c.criteriaRefId);
                added++;
            }
            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        await logAudit(pool, req, {
            action: 'CRITERIA_CREATE', entityType: 'Tender', entityId: tenderId,
            description: `Added ${added} evaluation criterion(s) to tender ${tenderId}`,
        });

        res.status(201).json({ message: `${added} criterion(s) added`, added });
    } catch (err) {
        console.error('[POST criteria] Error:', err.message);
        res.status(500).json({ message: 'Failed to add evaluation criteria' });
    }
});

// ── PUT /api/tenders/:tenderId/criteria/:criteriaId 

router.put('/:tenderId/criteria/:criteriaId', requireAdmin, async (req, res) => {
    const { tenderId, criteriaId } = req.params;
    const { maxScore, weight } = req.body;

    if (isNaN(parseFloat(weight)) || parseFloat(weight) <= 0)
        return res.status(400).json({ message: 'Weight must be a number greater than 0' });
    if (isNaN(parseFloat(maxScore)) || parseFloat(maxScore) <= 0)
        return res.status(400).json({ message: 'Max score must be a number greater than 0' });

    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('criteriaId', sql.VarChar(50),   criteriaId)
            .input('tenderId',   sql.VarChar(50),   tenderId)
            .input('maxScore',   sql.Decimal(9, 2), parseFloat(maxScore))
            .input('weight',     sql.Decimal(5, 2), parseFloat(weight))
            .query(`
                UPDATE EvaluationCriteria SET
                    MaxScore  = @maxScore,
                    Weight    = @weight,
                    UpdatedAt = GETDATE()
                WHERE CriteriaID = @criteriaId AND TenderID = @tenderId
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Criteria not found' });

        await logAudit(pool, req, {
            action: 'CRITERIA_UPDATE', entityType: 'Tender', entityId: tenderId,
            description: `Updated evaluation criterion ${criteriaId} on tender ${tenderId} (weight ${weight}%, max ${maxScore})`,
        });

        res.json({ message: 'Criteria updated successfully' });
    } catch (err) {
        console.error('[PUT criteria] Error:', err.message);
        res.status(500).json({ message: 'Failed to update evaluation criteria' });
    }
});

// ── DELETE /api/tenders/:tenderId/criteria/:criteriaId 
router.delete('/:tenderId/criteria/:criteriaId', requireAdmin, async (req, res) => {
    const { tenderId, criteriaId } = req.params;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('criteriaId', sql.VarChar(50), criteriaId)
            .input('tenderId',   sql.VarChar(50), tenderId)
            .query(`DELETE FROM EvaluationCriteria WHERE CriteriaID = @criteriaId AND TenderID = @tenderId`);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Criteria not found' });

        await logAudit(pool, req, {
            action: 'CRITERIA_DELETE', entityType: 'Tender', entityId: tenderId,
            description: `Removed evaluation criterion ${criteriaId} from tender ${tenderId}`,
        });

        res.json({ message: 'Criteria removed successfully' });
    } catch (err) {
        console.error('[DELETE criteria] Error:', err.message);
        res.status(500).json({ message: 'Failed to remove evaluation criteria' });
    }
});

// =============================================================================
// EVALUATION PANEL (committee members)
// =============================================================================

// ── GET /api/tenders/:tenderId/panel 
router.get('/:tenderId/panel', requireAdmin, async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('tenderId', sql.VarChar(50), req.params.tenderId)
            .query(`
                SELECT PanelMemberID, TenderID, PanelMemberDirectory.Name, PanelMemberDirectory.Designation, PanelMemberDirectory.Department, Role, Status
                FROM EvaluationPanel
                JOIN PanelMemberDirectory  ON EvaluationPanel.MemberID = PanelMemberDirectory.MemberID
                WHERE TenderID = @tenderId
                ORDER BY
                    CASE Role WHEN 'Chairperson' THEN 0 WHEN 'Secretary' THEN 1 ELSE 2 END,
                    EvaluationPanel.CreatedAt ASC
            `);
        res.json(result.recordset.map(mapPanelMember));
    } catch (err) {
        console.error('[GET panel] Error:', err.message);
        res.status(500).json({ message: 'Failed to load evaluation panel' });
    }
});

// ── POST /api/tenders/:tenderId/panel 

router.post('/:tenderId/panel', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    const { members } = req.body;

    if (!Array.isArray(members) || members.length === 0)
        return res.status(400).json({ message: 'Select at least one member to add' });

    try {
        const pool = await getPool();

        const tenderCheck = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT 1 FROM Tender WHERE TenderID = @tenderId`);
        if (tenderCheck.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        // Directory members already on this panel — to skip duplicates.
        const existingRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT PanelMemberID FROM EvaluationPanel WHERE TenderID = @tenderId AND PanelMemberID IS NOT NULL`);
        const alreadyAdded = new Set(existingRes.recordset.map(r => r.PanelMemberID));

        let added = 0;
        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            for (const m of members) {
                if (!m || !m.MemberId || alreadyAdded.has(m.MemberId)) continue;

                // Snapshot the person's details from the directory.
                const dir = await transaction.request()
                    .input('id', sql.VarChar(50), m.MemberId)
                    .query(`SELECT Name, Designation, Department FROM PanelMemberDirectory WHERE MemberID = @id`);
                if (dir.recordset.length === 0) continue;
                const person = dir.recordset[0];

                const safeRole   = PANEL_ROLES.includes(m.role) ? m.role : 'Member';
                const safeStatus = PANEL_STATUSES.includes(m.status) ? m.status : 'Pending';

                await transaction.request()
                    .input('panelmemberId',    sql.VarChar(50),   generateId('PANEL'))
                    .input('tenderId',    sql.VarChar(50),   tenderId)
                    .input('memberId',    sql.VarChar(50),   m.MemberId)
                    .input('designation', sql.NVarChar(255), person.Designation || '')
                    .input('department',  sql.NVarChar(255), person.Department || '')
                    .input('role',        sql.NVarChar(50),  safeRole)
                    .input('status',      sql.NVarChar(50),  safeStatus)
                    .query(`
                        INSERT INTO EvaluationPanel
                            (PanelMemberID, TenderID, MemberID, Designation, Department, Role, Status, CreatedAt, UpdatedAt)
                        VALUES
                            (@panelmemberId, @tenderId, @memberId, @designation, @department, @role, @status, GETDATE(), GETDATE())
                    `);
                alreadyAdded.add(m.MemberId);
                added++;
            }
            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        await logAudit(pool, req, {
            action: 'PANEL_MEMBER_ADD', entityType: 'Tender', entityId: tenderId,
            description: `Added ${added} member(s) to the evaluation panel of tender ${tenderId}`,
        });

        res.status(201).json({ message: `${added} member(s) added`, added });
    } catch (err) {
        console.error('[POST panel] Error:', err.message);
        res.status(500).json({ message: 'Failed to add panel members' });
    }
});

// ── PUT /api/tenders/:tenderId/panel/:panelmemberId 
router.put('/:tenderId/panel/:panelmemberId', requireAdmin, async (req, res) => {
    const { tenderId, panelmemberId } = req.params;
    const { designation, department, role, status } = req.body;  

    // Get the existing member to fetch their name and MemberID
    try {
        const pool = await getPool();
        
        // First get the existing panel member details
        const existingRes = await pool.request()
            .input('panelMemberId', sql.VarChar(50), panelmemberId)
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT ep.MemberID, pmd.Name 
                FROM EvaluationPanel ep
                JOIN PanelMemberDirectory pmd ON ep.MemberID = pmd.MemberID
                WHERE ep.PanelMemberID = @panelMemberId AND ep.TenderID = @tenderId
            `);
        
        if (existingRes.recordset.length === 0)
            return res.status(404).json({ message: 'Panel member not found' });
        
        const existing = existingRes.recordset[0];
        const safeRole = PANEL_ROLES.includes(role) ? role : 'Member';
        const safeStatus = PANEL_STATUSES.includes(status) ? status : 'Pending';

        const result = await pool.request()
            .input('panelMemberId', sql.VarChar(50), panelmemberId)
            .input('tenderId', sql.VarChar(50), tenderId)
            .input('designation', sql.NVarChar(255), (designation || '').trim())
            .input('department', sql.NVarChar(255), (department || '').trim())
            .input('role', sql.NVarChar(50), safeRole)
            .input('status', sql.NVarChar(50), safeStatus)
            .query(`
                UPDATE EvaluationPanel SET
                    Designation = @designation,
                    Department = @department,
                    Role = @role,
                    Status = @status,
                    UpdatedAt = GETDATE()
                WHERE PanelMemberID = @panelMemberId AND TenderID = @tenderId
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Panel member not found' });

        await logAudit(pool, req, {
            action: 'PANEL_MEMBER_UPDATE', 
            entityType: 'Tender', 
            entityId: tenderId,
            description: `Updated panel member "${existing.Name}" (${safeRole}, ${safeStatus}) on tender ${tenderId}`,
        });

        res.json(mapPanelMember({
            PanelMemberID: panelmemberId, 
            TenderID: tenderId, 
            MemberID: existing.MemberID, 
            MemberName: existing.Name,
            Designation: designation || '', 
            Department: department || '', 
            Role: safeRole, 
            Status: safeStatus,
        }));
    } catch (err) {
        console.error('[PUT panel] Error:', err.message);
        res.status(500).json({ message: 'Failed to update panel member' });
    }
});

// ── DELETE /api/tenders/:tenderId/panel/:panelmemberId 
router.delete('/:tenderId/panel/:panelmemberId', requireAdmin, async (req, res) => {
    const { tenderId, panelmemberId } = req.params;
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input('panelMemberId', sql.VarChar(50), panelmemberId)
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`DELETE FROM EvaluationPanel WHERE PanelMemberID = @panelMemberId AND TenderID = @tenderId`);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Panel member not found' });

        await logAudit(pool, req, {
            action: 'PANEL_MEMBER_REMOVE', entityType: 'Tender', entityId: tenderId,
            description: `Removed panel member ${panelmemberId} from tender ${tenderId}`,
        });

        res.json({ message: 'Panel member removed successfully' });
    } catch (err) {
        console.error('[DELETE panel] Error:', err.message);
        res.status(500).json({ message: 'Failed to remove panel member' });
    }
});

// =============================================================================
// PRELIMINARY (ADMINISTRATIVE) EVALUATION
// Checklist columns come from the tender's Required Documents.
// =============================================================================

// ── GET /api/tenders/:tenderId/preliminary ───────────────────────────────────
router.get('/:tenderId/preliminary', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    try {
        const pool = await getPool();

        // 1. Required documents for this tender -> checklist columns
        const tenderRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT RequiredDocuments FROM Tender WHERE TenderID = @tenderId`);
        if (tenderRes.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        const requiredKeys = parseRequiredDocs(tenderRes.recordset[0].RequiredDocuments);
        const checklist = requiredKeys.map(key => ({
            key,
            name: DOCUMENT_CONFIG[key]?.name || key,
        }));

        // 2. Bids for this tender
        const bidsRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT b.BidID, b.SupplierID, sp.CompanyName, bs.BidStatusName AS Status
                FROM Bid b
                JOIN SupplierProfile sp ON b.SupplierID  = sp.SupplierID
                JOIN BidStatus       bs ON b.BidStatusID = bs.BidStatusID
                WHERE b.TenderID = @tenderId
                ORDER BY b.SubmittedDate ASC
            `);

        // 3. Saved preliminary rows
        const savedRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT BidID, Results, Remarks, Outcome FROM PreliminaryEvaluation WHERE TenderID = @tenderId`);
        const savedByBid = {};
        savedRes.recordset.forEach(r => {
            let results = {};
            try { results = r.Results ? JSON.parse(r.Results) : {}; } catch { results = {}; }
            savedByBid[r.BidID] = { results, remarks: r.Remarks || '', outcome: r.Outcome || 'Pending' };
        });

        const rows = bidsRes.recordset.map(b => {
            const saved = savedByBid[b.BidID] || { results: {}, remarks: '' };
            return {
                bidId:     b.BidID,
                supplierId: b.SupplierID,
                company:   b.CompanyName,
                bidStatus: b.Status,
                results:   saved.results,
                remarks:   saved.remarks,
                outcome:   computePrelimOutcome(requiredKeys, saved.results),
            };
        });

        res.json({ checklist, rows });
    } catch (err) {
        console.error('[GET preliminary] Error:', err.message);
        res.status(500).json({ message: 'Failed to load preliminary evaluation' });
    }
});

// ── PUT /api/tenders/:tenderId/preliminary

router.put('/:tenderId/preliminary', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    const { evaluations } = req.body;

    if (!Array.isArray(evaluations))
        return res.status(400).json({ message: 'evaluations must be an array' });

    try {
        const pool = await getPool();

        const tenderRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT RequiredDocuments FROM Tender WHERE TenderID = @tenderId`);
        if (tenderRes.recordset.length === 0)
            return res.status(404).json({ message: 'Tender not found' });

        const requiredKeys = parseRequiredDocs(tenderRes.recordset[0].RequiredDocuments);

        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            for (const ev of evaluations) {
                if (!ev || !ev.bidId) continue;

                // Keep only valid Pass/Fail values for known required keys
                const cleanResults = {};
                const src = ev.results || {};
                for (const key of requiredKeys) {
                    if (src[key] === 'Pass' || src[key] === 'Fail') cleanResults[key] = src[key];
                }
                const outcome = computePrelimOutcome(requiredKeys, cleanResults);
                const resultsJson = JSON.stringify(cleanResults);

                await transaction.request()
                    .input('prelimId',  sql.VarChar(50),       generateId('PRELIM'))
                    .input('tenderId',  sql.VarChar(50),       tenderId)
                    .input('bidId',     sql.VarChar(50),       ev.bidId)
                    .input('results',   sql.NVarChar(sql.MAX), resultsJson)
                    .input('remarks',   sql.NVarChar(sql.MAX), (ev.remarks || '').trim())
                    .input('outcome',   sql.NVarChar(20),      outcome)
                    .query(`
                        IF EXISTS (SELECT 1 FROM PreliminaryEvaluation WHERE BidID = @bidId)
                            UPDATE PreliminaryEvaluation SET
                                Results = @results, Remarks = @remarks, Outcome = @outcome,
                                EvaluatedAt = GETDATE(), UpdatedAt = GETDATE()
                            WHERE BidID = @bidId
                        ELSE
                            INSERT INTO PreliminaryEvaluation
                                (PrelimID, TenderID, BidID, Results, Remarks, Outcome, EvaluatedAt, UpdatedAt)
                            VALUES
                                (@prelimId, @tenderId, @bidId, @results, @remarks, @outcome, GETDATE(), GETDATE())
                    `);
            }
            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        await logAudit(pool, req, {
            action: 'PRELIM_SAVE', entityType: 'Tender', entityId: tenderId,
            description: `Saved preliminary evaluation for ${evaluations.length} bid(s) on tender ${tenderId}`,
        });

        res.json({ message: 'Preliminary evaluation saved successfully' });
    } catch (err) {
        console.error('[PUT preliminary] Error:', err.message);
        res.status(500).json({ message: 'Failed to save preliminary evaluation' });
    }
});

// =============================================================================
// TECHNICAL EVALUATION
// Score columns come from the tender's selected EvaluationCriteria.
// =============================================================================

// ── GET /api/tenders/:tenderId/technical ─────────────────────────────────────
router.get('/:tenderId/technical', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    try {
        const pool = await getPool();

        // 1. The tender's selected criteria become the score columns.
        const critRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT CriteriaID, CriteriaName, MaxScore, Weight
                FROM EvaluationCriteria
                WHERE TenderID = @tenderId
                ORDER BY SortOrder ASC, CreatedAt ASC
            `);
        const criteria = critRes.recordset.map(c => ({
            id:       c.CriteriaID,
            name:     c.CriteriaName,
            maxScore: Number(c.MaxScore) || 0,
            weight:   Number(c.Weight) || 0,
        }));

        // 2. Bids for this tender.
        const bidsRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT b.BidID, b.SupplierID, sp.CompanyName
                FROM Bid b
                JOIN SupplierProfile sp ON b.SupplierID = sp.SupplierID
                WHERE b.TenderID = @tenderId
                ORDER BY b.SubmittedDate ASC
            `);

        // 3. Preliminary outcomes — bidders who FAILED preliminary are excluded
        //    from technical evaluation. (Pending/Pass bidders proceed.)
        const prelimRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT BidID, Outcome FROM PreliminaryEvaluation WHERE TenderID = @tenderId`);
        const prelimByBid = {};
        prelimRes.recordset.forEach(r => { prelimByBid[r.BidID] = r.Outcome; });

        const eligibleBids = bidsRes.recordset.filter(b => prelimByBid[b.BidID] !== 'Fail');
        const excludedFailedPrelim = bidsRes.recordset.length - eligibleBids.length;

        // 4. Saved technical rows.
        const savedRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT BidID, Scores FROM TechnicalEvaluation WHERE TenderID = @tenderId`);
        const savedByBid = {};
        savedRes.recordset.forEach(r => {
            let scores = {};
            try { scores = r.Scores ? JSON.parse(r.Scores) : {}; } catch { scores = {}; }
            savedByBid[r.BidID] = scores;
        });

        const rows = eligibleBids.map(b => {
            const scores = savedByBid[b.BidID] || {};
            const { total, outcome } = computeTechResult(criteria, scores);
            return { bidId: b.BidID, supplierId: b.SupplierID, company: b.CompanyName, scores, total, outcome };
        });

        res.json({ criteria, passMark: TECH_PASS_MARK, rows, excludedFailedPrelim });
    } catch (err) {
        console.error('[GET technical] Error:', err.message);
        res.status(500).json({ message: 'Failed to load technical evaluation' });
    }
});

// ── PUT /api/tenders/:tenderId/technical 

router.put('/:tenderId/technical', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    const { evaluations } = req.body;

    if (!Array.isArray(evaluations))
        return res.status(400).json({ message: 'evaluations must be an array' });

    try {
        const pool = await getPool();

        // Load criteria once — used to validate keys and compute outcomes.
        const critRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT CriteriaID, MaxScore, Weight FROM EvaluationCriteria WHERE TenderID = @tenderId`);
        const criteria = critRes.recordset.map(c => ({
            id: c.CriteriaID, maxScore: Number(c.MaxScore) || 0, weight: Number(c.Weight) || 0,
        }));
        const validIds = new Set(criteria.map(c => c.id));

        // Bidders who failed preliminary are not scored technically — ignore any
        // such rows even if a stale client submits them.
        const failedRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`SELECT BidID FROM PreliminaryEvaluation WHERE TenderID = @tenderId AND Outcome = 'Fail'`);
        const failedPrelim = new Set(failedRes.recordset.map(r => r.BidID));

        const transaction = new sql.Transaction(pool);
        await transaction.begin();
        try {
            for (const ev of evaluations) {
                if (!ev || !ev.bidId || failedPrelim.has(ev.bidId)) continue;

                // Keep only valid numeric scores for known criteria.
                const cleanScores = {};
                const src = ev.scores || {};
                for (const id of Object.keys(src)) {
                    if (!validIds.has(id)) continue;
                    const v = src[id];
                    if (v === '' || v === null || v === undefined) continue;
                    if (!isNaN(Number(v))) cleanScores[id] = Number(v);
                }
                const { total, outcome } = computeTechResult(criteria, cleanScores);

                await transaction.request()
                    .input('techId',   sql.VarChar(50),       generateId('TECH'))
                    .input('tenderId', sql.VarChar(50),       tenderId)
                    .input('bidId',    sql.VarChar(50),       ev.bidId)
                    .input('scores',   sql.NVarChar(sql.MAX), JSON.stringify(cleanScores))
                    .input('total',    sql.Decimal(6, 2),     total)
                    .input('outcome',  sql.NVarChar(20),      outcome)
                    .query(`
                        IF EXISTS (SELECT 1 FROM TechnicalEvaluation WHERE BidID = @bidId)
                            UPDATE TechnicalEvaluation SET
                                Scores = @scores, Total = @total, Outcome = @outcome,
                                EvaluatedAt = GETDATE(), UpdatedAt = GETDATE()
                            WHERE BidID = @bidId
                        ELSE
                            INSERT INTO TechnicalEvaluation
                                (TechID, TenderID, BidID, Scores, Total, Outcome, EvaluatedAt, UpdatedAt)
                            VALUES
                                (@techId, @tenderId, @bidId, @scores, @total, @outcome, GETDATE(), GETDATE())
                    `);
            }
            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        await logAudit(pool, req, {
            action: 'TECH_SAVE', entityType: 'Tender', entityId: tenderId,
            description: `Saved technical evaluation for ${evaluations.length} bid(s) on tender ${tenderId}`,
        });

        res.json({ message: 'Technical evaluation saved successfully' });
    } catch (err) {
        console.error('[PUT technical] Error:', err.message);
        res.status(500).json({ message: 'Failed to save technical evaluation' });
    }
});

// =============================================================================
// RESPONSIVENESS (derived — read only)
//   Responsive     = passed preliminary AND passed technical
//   Non-Responsive = failed preliminary OR failed technical
//   Pending        = anything still awaiting an evaluation step
// =============================================================================

// Shared derivation used by the responsiveness tab and the award gate.
async function loadResponsivenessRows(pool, tenderId) {
    const bidsRes = await pool.request()
        .input('tenderId', sql.VarChar(50), tenderId)
        .query(`
            SELECT b.BidID, b.SupplierID, sp.CompanyName
            FROM Bid b
            JOIN SupplierProfile sp ON b.SupplierID = sp.SupplierID
            WHERE b.TenderID = @tenderId
            ORDER BY b.SubmittedDate ASC
        `);

    const prelimRes = await pool.request()
        .input('tenderId', sql.VarChar(50), tenderId)
        .query(`SELECT BidID, Outcome FROM PreliminaryEvaluation WHERE TenderID = @tenderId`);
    const prelimBy = {};
    prelimRes.recordset.forEach(r => { prelimBy[r.BidID] = r.Outcome; });

    const techRes = await pool.request()
        .input('tenderId', sql.VarChar(50), tenderId)
        .query(`SELECT BidID, Outcome, Total FROM TechnicalEvaluation WHERE TenderID = @tenderId`);
    const techBy = {};
    techRes.recordset.forEach(r => { techBy[r.BidID] = { outcome: r.Outcome, total: Number(r.Total) || 0 }; });

    return bidsRes.recordset.map(b => {
        const prelim = prelimBy[b.BidID] || 'Pending';
        const tech = techBy[b.BidID]?.outcome || 'Pending';
        const techTotal = techBy[b.BidID] ? techBy[b.BidID].total : null;

        let status, reason;
        if (prelim === 'Fail')                          { status = 'Non-Responsive'; reason = 'Failed preliminary evaluation'; }
        else if (tech === 'Fail')                       { status = 'Non-Responsive'; reason = 'Failed technical evaluation'; }
        else if (prelim === 'Pass' && tech === 'Pass')  { status = 'Responsive';     reason = ''; }
        else { status = 'Pending'; reason = prelim !== 'Pass' ? 'Awaiting preliminary evaluation' : 'Awaiting technical evaluation'; }

        return {
            bidId: b.BidID, supplierId: b.SupplierID, company: b.CompanyName,
            prelimOutcome: prelim, techOutcome: tech, techTotal, status, reason,
        };
    });
}

router.get('/:tenderId/responsiveness', requireAdmin, async (req, res) => {
    try {
        const pool = await getPool();
        const rows = await loadResponsivenessRows(pool, req.params.tenderId);
        res.json({ rows });
    } catch (err) {
        console.error('[GET responsiveness] Error:', err.message);
        res.status(500).json({ message: 'Failed to load responsiveness' });
    }
});

// =============================================================================
// EVALUATION STATUS (the award gate)

// =============================================================================
router.get('/:tenderId/evaluation-status', requireAdmin, async (req, res) => {
    const { tenderId } = req.params;
    try {
        const pool = await getPool();

        const countsRes = await pool.request()
            .input('tenderId', sql.VarChar(50), tenderId)
            .query(`
                SELECT
                    (SELECT COUNT(*) FROM EvaluationCriteria WHERE TenderID = @tenderId) AS critCount,
                    (SELECT COUNT(*) FROM EvaluationPanel    WHERE TenderID = @tenderId) AS panelCount
            `);
        const { critCount, panelCount } = countsRes.recordset[0] || { critCount: 0, panelCount: 0 };

        const rows = await loadResponsivenessRows(pool, tenderId);
        const hasBids = rows.length > 0;
        const anyPending = rows.some(r => r.status === 'Pending');

        const evaluationConfigured = critCount > 0 || panelCount > 0;
        const evaluationComplete = evaluationConfigured && hasBids && !anyPending;

        const nonResponsiveSupplierIds = rows.filter(r => r.status === 'Non-Responsive').map(r => r.supplierId);
        const responsiveSupplierIds = rows.filter(r => r.status === 'Responsive').map(r => r.supplierId);

        res.json({ evaluationConfigured, evaluationComplete, nonResponsiveSupplierIds, responsiveSupplierIds });
    } catch (err) {
        console.error('[GET evaluation-status] Error:', err.message);
        res.status(500).json({ message: 'Failed to load evaluation status' });
    }
});

module.exports = router;
