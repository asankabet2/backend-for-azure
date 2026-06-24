// helpers/tenderHelpers.js
const { getPool, sql } = require('../db/procurement');

function mapTenderStatus(status) {
    const map = { Draft: 'TS001', Open: 'TS002', Closed: 'TS003', Awarded: 'TS004' };
    return map[status] || 'TS001';
}

async function generateRegistrationNumber(pool) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const prefix = `Reg${yearMonth}`;

    const result = await pool.request()
        .input('prefix', sql.VarChar(20), prefix)
        .query(`
            MERGE RegistrationCounters WITH (HOLDLOCK) AS target
            USING (VALUES (@prefix)) AS source (Prefix)
            ON target.Prefix = source.Prefix
            WHEN MATCHED THEN
                UPDATE SET LastSeq = target.LastSeq + 1
            WHEN NOT MATCHED THEN
                INSERT (Prefix, LastSeq) VALUES (@prefix, 1)
            OUTPUT inserted.LastSeq;
        `);

    const seq = result.recordset[0].LastSeq;
    return `${prefix}${String(seq).padStart(5, '0')}`;
}

module.exports = { mapTenderStatus, generateRegistrationNumber };