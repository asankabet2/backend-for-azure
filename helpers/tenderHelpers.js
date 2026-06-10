// helpers/tenderHelpers.js
const { getPool, sql } = require('../db/procurement');

function mapTenderStatus(status) {
    const map = { Draft: 'TS001', Open: 'TS002', Closed: 'TS003', Awarded: 'TS004' };
    return map[status] || 'TS001';
}

async function generateRegistrationNumber(pool) {
    const now = new Date();
    const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;

    const result = await pool.request()
        .input('pattern', sql.VarChar(50), `Reg${yearMonth}%`)
        .query(`
            SELECT TOP 1 RegistrationNumber FROM SupplierProfile
            WHERE RegistrationNumber LIKE @pattern
            ORDER BY RegistrationNumber DESC
        `);

    let nextNumber = 1;
    if (result.recordset.length > 0) {
        const lastSeq = parseInt(result.recordset[0].RegistrationNumber.slice(-5), 10);
        if (!isNaN(lastSeq)) nextNumber = lastSeq + 1;
    }
    return `Reg${yearMonth}${String(nextNumber).padStart(5, '0')}`;
}

module.exports = { mapTenderStatus, generateRegistrationNumber };