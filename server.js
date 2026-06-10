// server.js
require('dotenv').config();

const app = require('./app');
const { startCronJobs } = require('./jobs/tenderCron');

const PORT = process.env.PORT || 5001;

// Validate required env vars
if (!process.env.JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET is not set in .env. Exiting.');
    process.exit(1);
}

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

startCronJobs();

// Graceful shutdown
const shutdown = () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Crash handlers
process.on('uncaughtException', (err) => {
    console.error('[CRASH] Uncaught Exception:', err);
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[CRASH] Unhandled Rejection:', reason);
    process.exit(1);
});