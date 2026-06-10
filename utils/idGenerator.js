// utils/idGenerator.js
const { getPool } = require('../db/procurement');

// Random unique id:  <PREFIX>-<timestamp36>-<random4>   e.g. BID-LXR3K9-A1B2
function generateId(prefix) {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    return `${prefix}-${ts}-${rnd}`.toUpperCase();
}

class IDGenerator {

    // Generate next tendercategoryid (CAT0001, CAT0002, CAT0010...)
    static async generateCategoryId() {
        try {
            const pool = await getPool();
            const result = await pool.request().query(`
                SELECT TOP 1 tendercategoryid
                FROM tendercategory
                ORDER BY tendercategoryid DESC
            `);

            if (!result.recordset || result.recordset.length === 0) {
                return 'CAT0001';
            }

            const lastId = result.recordset[0].tendercategoryid;
            const lastNumber = parseInt(lastId.replace('CAT', ''));
            const newNumber = lastNumber + 1;
            return `CAT${String(newNumber).padStart(4, '0')}`;
        } catch (err) {
            console.error('[IDGenerator] generateCategoryId error:', err);
            return 'CAT0001';
        }
    }
}

// Single export so BOTH the helper function and the class are available.
// (Previously a second `module.exports = IDGenerator` clobbered `generateId`.)
module.exports = { generateId, IDGenerator };
