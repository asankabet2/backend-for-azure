// jobs/tenderCron.js
const cron = require('node-cron');
const { getPool, sql } = require('../db/procurement');
const { createNotification, getAdminUserIds, getSupplierUserId } = require('../helpers/notifications');

async function updateTenderStatuses() {
    const pool = await getPool();
    const today = new Date().toISOString().split('T')[0];
    const in3 = new Date();
    in3.setDate(new Date().getDate() + 3);
    const in3Str = in3.toISOString().split('T')[0];

    // Update statuses
    await pool.request()
        .input('today', sql.Date, today)
        .query(`UPDATE Tender SET TenderStatusID = 'TS002', UpdatedAt = GETDATE()
                WHERE TenderStatusID = 'TS001' AND OpeningDate <= @today AND ClosingDate > @today`);

    await pool.request()
        .input('today', sql.Date, today)
        .query(`UPDATE Tender SET TenderStatusID = 'TS003', UpdatedAt = GETDATE()
                WHERE TenderStatusID = 'TS002' AND ClosingDate < @today`);

    // Notify about tenders closing in 3 days
    const closingSoon = await pool.request()
        .input('today', sql.Date, today)
        .input('in3', sql.Date, in3Str)
        .query(`
            SELECT t.TenderID, t.Title, t.ClosingDate
            FROM Tender t
            WHERE t.TenderStatusID = 'TS002'
              AND t.ClosingDate BETWEEN @today AND @in3
        `);

    for (const tender of closingSoon.recordset) {
        const interested = await pool.request()
            .input('tenderId', sql.VarChar(50), tender.TenderID)
            .query(`
                SELECT su.UserID
                FROM Interests i
                JOIN SystemUser su ON i.SupplierID = su.SupplierID
                WHERE i.TenderID = @tenderId AND su.Role = 'supplier'
            `);

        for (const row of interested.recordset) {
            await createNotification(pool, {
                userId: row.UserID,
                message: `Tender "${tender.Title}" closes on ${tender.ClosingDate.toISOString().split('T')[0]}. Don't miss the deadline!`,
                type: 'warning',
                link: `/supplier/tenders/${tender.TenderID}`,
            });
        }

        const adminIds = await getAdminUserIds(pool);
        for (const adminUserId of adminIds) {
            await createNotification(pool, {
                userId: adminUserId,
                message: `Tender "${tender.Title}" is closing on ${tender.ClosingDate.toISOString().split('T')[0]}.`,
                type: 'warning',
                link: `/admin/tenders/${tender.TenderID}`,
            });
        }
    }

    console.log('[Cron] Tender statuses updated, closing-soon notifications sent');
}

function startCronJobs() {
    cron.schedule('0 0 * * *', async () => {
        try {
            await updateTenderStatuses();
        } catch (err) {
            console.error('[Cron] Error:', err.message);
        }
    });
    console.log('[Cron] Jobs scheduled');
}

module.exports = { startCronJobs, updateTenderStatuses };