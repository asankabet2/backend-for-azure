const sql = require('mssql/msnodesqlv8');


const config = {
    connectionString: 'Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=PROCUREMENTDB;Trusted_Connection=yes;TrustServerCertificate=yes;',
    connectionTimeout: 30000,
    requestTimeout: 30000
};

let pool = null;

async function getPool() {
    try {
        if (!pool) {
            pool = await sql.connect(config);
            console.log('[SQL Server] Connected successfully to PROCUREMENTDB');
        }
        return pool;
    } catch (err) {
        console.error('[SQL Server] Connection error:', err);
        throw err;
    }
}

getPool().catch(err => console.error('[SQL Server] Initial connection failed:', err.message));

module.exports = { sql, getPool };