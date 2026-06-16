'use strict';

// helpers/evaluationHelpers.js
// Shared evaluation logic used by bids.js and tender.routes.js
// to gate awarding behind completed evaluation.

/**
 * Derive responsiveness rows for every bid on a tender.
 * Responsive     = passed preliminary AND passed technical
 * Non-Responsive = failed preliminary OR failed technical
 * Pending        = awaiting one or both evaluation steps
 */
async function loadResponsivenessRows(pool, sql, tenderId) {
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
    techRes.recordset.forEach(r => {
        techBy[r.BidID] = { outcome: r.Outcome, total: Number(r.Total) || 0 };
    });

    return bidsRes.recordset.map(b => {
        const prelim    = prelimBy[b.BidID]           || 'Pending';
        const tech      = techBy[b.BidID]?.outcome    || 'Pending';
        const techTotal = techBy[b.BidID]?.total      ?? null;

        let status, reason;
        if (prelim === 'Fail') {
            status = 'Non-Responsive'; reason = 'Failed preliminary evaluation';
        } else if (tech === 'Fail') {
            status = 'Non-Responsive'; reason = 'Failed technical evaluation';
        } else if (prelim === 'Pass' && tech === 'Pass') {
            status = 'Responsive'; reason = '';
        } else {
            status = 'Pending';
            reason = prelim !== 'Pass'
                ? 'Awaiting preliminary evaluation'
                : 'Awaiting technical evaluation';
        }

        return {
            bidId: b.BidID, supplierId: b.SupplierID, company: b.CompanyName,
            prelimOutcome: prelim, techOutcome: tech, techTotal, status, reason,
        };
    });
}

/**
 * Run all five award eligibility gates for a tender.
 * Returns { eligible: true } if awarding is allowed, or
 * { eligible: false, reason: '...' } with a descriptive message.
 *
 * Gates (in order):
 *   1. Tender must be Closed
 *   2. Tender must have at least one bid
 *   3. Evaluation must be configured (criteria or panel set up)
 *   4. Evaluation must be complete (no bids still Pending)
 *   5. At least one responsive supplier must exist
 */
async function checkAwardEligibility(pool, sql, tenderId) {
    // Gate 1 — tender status
    const tenderRes = await pool.request()
        .input('tenderId', sql.VarChar(50), tenderId)
        .query(`
            SELECT ts.TenderStatusName
            FROM Tender t
            JOIN TenderStatus ts ON t.TenderStatusID = ts.TenderStatusID
            WHERE t.TenderID = @tenderId
        `);

    if (tenderRes.recordset.length === 0)
        return { eligible: false, reason: 'Tender not found.' };

    const tenderStatus = tenderRes.recordset[0].TenderStatusName;
    if (tenderStatus !== 'Closed')
        return {
            eligible: false,
            reason: `Tender must be Closed before awarding. Current status: '${tenderStatus}'.`,
        };

    // Gate 2 — at least one bid
    const rows = await loadResponsivenessRows(pool, sql, tenderId);
    if (rows.length === 0)
        return {
            eligible: false,
            reason: 'No bids have been submitted for this tender. The tender should be re-advertised or cancelled.',
        };

    // Gate 3 — evaluation configured
    const countsRes = await pool.request()
        .input('tenderId', sql.VarChar(50), tenderId)
        .query(`
            SELECT
                (SELECT COUNT(*) FROM EvaluationCriteria WHERE TenderID = @tenderId) AS critCount,
                (SELECT COUNT(*) FROM EvaluationPanel    WHERE TenderID = @tenderId) AS panelCount
        `);
    const { critCount, panelCount } = countsRes.recordset[0] || { critCount: 0, panelCount: 0 };
    if (critCount === 0 && panelCount === 0)
        return {
            eligible: false,
            reason: 'Evaluation has not been configured for this tender. Please set up evaluation criteria and/or a panel before awarding.',
        };

    // Gate 4 — evaluation complete (no pending bids)
    const pendingBids = rows.filter(r => r.status === 'Pending');
    if (pendingBids.length > 0)
        return {
            eligible: false,
            reason: `Evaluation is incomplete. ${pendingBids.length} bid(s) are still pending review.`,
        };

    // Gate 5 — at least one responsive supplier
    const responsiveBids = rows.filter(r => r.status === 'Responsive');
    if (responsiveBids.length === 0)
        return {
            eligible: false,
            reason: 'All bidders were found non-responsive during evaluation. No eligible supplier can be awarded.',
        };

    return {
        eligible: true,
        responsiveSupplierIds: responsiveBids.map(r => r.supplierId),
        nonResponsiveSupplierIds: rows.filter(r => r.status === 'Non-Responsive').map(r => r.supplierId),
    };
}

module.exports = { loadResponsivenessRows, checkAwardEligibility };