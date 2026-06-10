// app.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Import route modules
const authRoutes = require('./routes/auth.routes');
const tenderRoutes = require('./routes/tender.routes');
const bidRoutes = require('./routes/bid.routes');
const supplierRoutes = require('./routes/supplier.routes');
const notificationRoutes = require('./routes/notification.routes');
const referenceRoutes = require('./routes/reference.routes');
const adminRoutes = require('./routes/admin.routes');
const categoryRoutes = require('./routes/categoryRoutes');
const interestRoutes = require('./routes/interest.routes');
const statsRoutes = require('./routes/stats.routes');
const auditRoutes = require('./routes/audit.routes');
const evaluationRoutes = require('./routes/evaluation.routes');
const panelMembersRoutes = require('./routes/panelMembers.routes');
const criteriaLibraryRoutes = require('./routes/criteriaLibrary.routes');
const emailRoutes = require('./routes/email.routes');


const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health check (public)
app.get('/api/health', (req, res) => {
    res.json({ status: 'OK', message: 'Backend running with SQL Server' });
});

// Mount all routes
app.use('/api/auth', authRoutes);
app.use('/api/tenders', tenderRoutes);
app.use('/api/tenders', evaluationRoutes);   // /:tenderId/criteria, evaluation flow
app.use('/api/bids', bidRoutes);
app.use('/api/suppliers', supplierRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api', referenceRoutes);        // regions, cities, countries, etc.
app.use('/api/admin', adminRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api', interestRoutes);         // tender interests
app.use('/api/email-templates', emailRoutes);   // admin email template management
app.use('/api/stats', statsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/panel-members', panelMembersRoutes);   // global evaluator directory
app.use('/api/criteria-library', criteriaLibraryRoutes);   // global criteria library

// Global error handler
app.use((err, req, res, next) => {
    console.error('[Global Error]', err);
    res.status(500).json({ message: err.message || 'Internal server error' });
});

module.exports = app;