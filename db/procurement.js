const sql = require('mssql');

const config = {
    server:   process.env.DB_SERVER,
    database: process.env.DB_NAME,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    port:     parseInt(process.env.DB_PORT) || 1433,
    options: {
        encrypt:                true,   // required for Azure
        trustServerCertificate: false,
    },
    connectionTimeout: 30000,
    requestTimeout:    30000,
};

let pool = null;

async function getPool() {
    try {
        if (!pool) {
            pool = await sql.connect(config);
            console.log('[SQL Server] Connected successfully to', process.env.DB_NAME);
        }
        return pool;
    } catch (err) {
        console.error('[SQL Server] Connection error:', err);
        throw err;
    }
}

getPool().catch(err => console.error('[SQL Server] Initial connection failed:', err.message));

module.exports = { sql, getPool };