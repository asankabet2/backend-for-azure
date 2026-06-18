// routes/supplier.routes.js
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { upload, uploadToBlob, downloadFile } = require('../utils/fileUpload');
const { getPool, sql }      = require('../db/procurement');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { generateRegistrationNumber } = require('../helpers/tenderHelpers');
const { createNotification, getAdminUserIds, getSupplierUserId } = require('../helpers/notifications');
const { DOCUMENT_CONFIG }   = require('../config/documents');
const { generateId }        = require('../utils/idGenerator');
const { logAudit }          = require('../helpers/audit');
const { sendTemplatedEmail } = require('../helpers/mailers');

const PORT = process.env.PORT || 5001;

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: { message: 'Too many registration attempts. Please try again later.' }
});

function verifySupplierUploadAccess(req, res, next) {
    const authHeader = req.headers.authorization;
    const token       = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const { supplierId } = req.params;

    if (!token) return res.status(401).json({ message: 'Authentication required' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        // Scoped token issued at registration — only valid for this one supplierId
        if (decoded.purpose === 'document-upload') {
            if (decoded.supplierId !== supplierId)
                return res.status(403).json({ message: 'Token does not match this supplier' });
            return next();
        }

        // Full login session (supplier uploading to own profile, or admin)
        if (decoded.role === 'admin' || decoded.userId === supplierId) {
            req.user = decoded;
            return next();
        }

        return res.status(403).json({ message: 'Forbidden: You can only upload to your own profile' });
    } catch (err) {
        return res.status(401).json({ message: 'Invalid or expired token' });
    }
}

// ── GET /api/suppliers/generate-registration-number  (public) 
router.get('/generate-registration-number', async (req, res) => {
    try {
        const pool               = await getPool();
        const registrationNumber = await generateRegistrationNumber(pool);
        res.json({ registrationNumber });
    } catch (error) {
        console.error('[GET generate-registration-number] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── POST /api/suppliers/register  (public) 
router.post('/register', registerLimiter, async (req, res) => {
    const {
        companyName, tin, dateOfIncorporation, countryOfIncorporation,
        companyTypeId, contactPerson, designation, email, phone, address,
        cityId, regionId, countryId, categories, password
    } = req.body;

    try {
        const pool          = await getPool();
        const existingEmail = await pool.request()
            .input('email', sql.VarChar(255), email)
            .query(`SELECT Email FROM SystemUser WHERE Email = @email`);

        if (existingEmail.recordset.length > 0)
            return res.status(400).json({ message: 'Email already registered' });

        const registrationNumber = await generateRegistrationNumber(pool);
        const supplierId         = generateId('SUP');
        const userId             = generateId('USR');
        const hashedPassword     = await bcrypt.hash(password, 10);

        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            await transaction.request()
                .input('supplierId',             sql.VarChar(50),       supplierId)
                .input('registrationNumber',     sql.VarChar(50),       registrationNumber)
                .input('companyName',            sql.NVarChar(255),     companyName)
                .input('tin',                    sql.VarChar(50),       tin || null)
                .input('dateOfIncorporation',    sql.Date,              dateOfIncorporation || null)
                .input('countryOfIncorporation', sql.NVarChar(100),     countryOfIncorporation || 'Ghana')
                .input('companyTypeId',          sql.VarChar(20),       companyTypeId || null)
                .input('contactPerson',          sql.NVarChar(255),     contactPerson)
                .input('designation',            sql.NVarChar(100),     designation || null)
                .input('email',                  sql.VarChar(255),      email)
                .input('phone',                  sql.VarChar(50),       phone || null)
                .input('address',                sql.NVarChar(sql.MAX), address || null)
                .input('cityId',                 sql.VarChar(20),       cityId || null)
                .input('regionId',               sql.VarChar(20),       regionId || null)
                .input('countryId',              sql.VarChar(20),       countryId || null)
                .input('profileStatusId',        sql.VarChar(20),       'PS001')
                .input('dateApplied',            sql.Date,              new Date().toISOString().split('T')[0])
                .query(`
                    INSERT INTO SupplierProfile (
                        SupplierID, RegistrationNumber, CompanyName, TIN,
                        DateOfIncorporation, CountryOfIncorporation, CompanyTypeID,
                        ContactPerson, Designation, Email, Phone, Address,
                        CityID, RegionID, CountryID, ProfileStatusID, DateApplied,
                        Documents, Experiences, CreatedAt
                    ) VALUES (
                        @supplierId, @registrationNumber, @companyName, @tin,
                        @dateOfIncorporation, @countryOfIncorporation, @companyTypeId,
                        @contactPerson, @designation, @email, @phone, @address,
                        @cityId, @regionId, @countryId, @profileStatusId, @dateApplied,
                        '[]', '[]', GETDATE()
                    )
                `);

            await transaction.request()
                .input('userId',       sql.VarChar(50),  userId)
                .input('email',        sql.VarChar(255), email)
                .input('passwordHash', sql.VarChar(255), hashedPassword)
                .input('role',         sql.VarChar(20),  'supplier')
                .input('supplierId',   sql.VarChar(50),  supplierId)
                .input('userStatusId', sql.VarChar(20),  'UST001')
                .query(`
                    INSERT INTO SystemUser
                        (UserID, Email, PasswordHash, Role, SupplierID, UserStatusID, IsFirstLogin, CreateDate)
                    VALUES
                        (@userId, @email, @passwordHash, @role, @supplierId, @userStatusId, 0, GETDATE())
                `);

            if (categories && categories.length > 0) {
                for (const categoryId of categories) {
                    await transaction.request()
                        .input('supplierId', sql.VarChar(50), supplierId)
                        .input('categoryId', sql.VarChar(20), categoryId)
                        .query(`INSERT INTO SupplierCategories (SupplierID, CategoryID) VALUES (@supplierId, @categoryId)`);
                }
            }

            await transaction.commit();

            // Notify all admins about the new registration
            const adminIds = await getAdminUserIds(pool);
            for (const adminUserId of adminIds) {
                await createNotification(pool, {
                    userId:   adminUserId,
                    userType: 'admin',
                    message:  `New supplier registration: ${companyName} is pending approval.`,
                    type:     'info',
                    link:     `/admin/suppliers/${supplierId}`,
                });
            }

            // Send registration received email to the supplier
            try {
                await sendTemplatedEmail(pool, sql, 'ETT006', email, {
                    supplierName: companyName,
                    orgName:      process.env.ORG_NAME || 'Procurement Portal',
                });
            } catch (mailErr) {
                console.error('[mailer] Failed to send registration email:', mailErr.message);
            }

            // Log audit record for supplier registration    
            await logAudit(pool, req, {
                action: 'SUPPLIER_REGISTER', entityType: 'Supplier', entityId: supplierId,
                description: `New supplier registration: ${companyName} (${email})`,
                actor: { userId: supplierId, role: 'supplier', email },
            });

            const uploadToken = jwt.sign(
                { supplierId, purpose: 'document-upload' },
                process.env.JWT_SECRET,
                { expiresIn: '30m' }
            );

            res.status(201).json({
                message: 'Registration successful! Please wait for admin approval.',
                supplierId,
                registrationNumber,
                uploadToken
            });    
        } catch (error) {
            await transaction.rollback();
            throw error;
        }
    } catch (error) {
        console.error('[POST /api/suppliers/register] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/suppliers  — admin only 
router.get('/', requireAdmin, async (req, res) => {
    try {
        const pool   = await getPool();
        const result = await pool.request().query(`
            SELECT
                sp.SupplierID AS id, sp.RegistrationNumber AS registrationNumber,
                sp.CompanyName AS companyName, sp.Email AS email, sp.DateApplied AS dateApplied,
                ps.ProfileStatusName AS status, sp.RejectionReason AS rejectionReason,
                sp.ContactPerson AS contactPerson, sp.Phone AS phone, sp.Address AS address,
                ct.CompanyTypeName AS companyType, r.RegionName AS region,
                c.CityName AS city, cnt.CountryName AS country,
                sp.CompanyTypeID, sp.RegionID, sp.CityID, sp.CountryID
            FROM SupplierProfile sp
            LEFT JOIN ProfileStatus ps  ON sp.ProfileStatusID = ps.ProfileStatusID
            LEFT JOIN CompanyType   ct  ON sp.CompanyTypeID   = ct.CompanyTypeID
            LEFT JOIN Regions        r  ON sp.RegionID        = r.RegionID
            LEFT JOIN Cities         c  ON sp.CityID          = c.CityID
            LEFT JOIN Countries    cnt  ON sp.CountryID       = cnt.CountryID
            ORDER BY sp.CreatedAt DESC
        `);

        const suppliers = result.recordset;
        const catResult = await pool.request().query(`
            SELECT sc.SupplierID, tc.TenderCategoryName
            FROM SupplierCategories sc
            JOIN TenderCategory tc ON sc.CategoryID = tc.TenderCategoryID
        `);

        const categoryMap = {};
        catResult.recordset.forEach(row => {
            if (!categoryMap[row.SupplierID]) categoryMap[row.SupplierID] = [];
            categoryMap[row.SupplierID].push(row.TenderCategoryName);
        });
        suppliers.forEach(s => { s.categories = categoryMap[s.id] || []; });

        res.json(suppliers);
    } catch (error) {
        console.error('[GET /api/suppliers] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/suppliers/:id  — admin OR the supplier themselves 
router.get('/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    if (req.user.role !== 'admin' && req.user.userId !== id)
        return res.status(403).json({ message: 'Forbidden: You can only access your own profile' });

    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId', sql.VarChar(50), id)
            .query(`
                SELECT
                    sp.SupplierID AS id, sp.RegistrationNumber AS registrationNumber,
                    sp.CompanyName AS companyName, sp.TIN AS tin,
                    sp.DateOfIncorporation AS dateOfIncorporation,
                    sp.CountryOfIncorporation AS countryOfIncorporation,
                    sp.ContactPerson AS contactPerson, sp.Designation,
                    sp.Email AS email, sp.Phone AS phone, sp.Address AS address,
                    ps.ProfileStatusName AS status, ps.ProfileStatusID AS statusId,
                    sp.RejectionReason AS rejectionReason, sp.DateApplied AS dateApplied,
                    sp.Documents, sp.Experiences,
                    sp.ExperienceCount AS experienceCount, sp.HasExperiences AS hasExperiences,
                    ct.CompanyTypeID,  ct.CompanyTypeName AS companyTypeName,  ct.KeyPrefix AS companyTypeKeyPrefix,
                     r.RegionID,        r.RegionName      AS regionName,        r.KeyPrefix AS regionKeyPrefix,
                     c.CityID,          c.CityName        AS cityName,
                   cnt.CountryID,     cnt.CountryName    AS countryName,      cnt.KeyPrefix AS countryKeyPrefix
                FROM SupplierProfile sp
                LEFT JOIN ProfileStatus ps  ON sp.ProfileStatusID = ps.ProfileStatusID
                LEFT JOIN CompanyType   ct  ON sp.CompanyTypeID   = ct.CompanyTypeID
                LEFT JOIN Regions        r  ON sp.RegionID        = r.RegionID
                LEFT JOIN Cities         c  ON sp.CityID          = c.CityID
                LEFT JOIN Countries    cnt  ON sp.CountryID       = cnt.CountryID
                WHERE sp.SupplierID = @supplierId
            `);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        const supplier  = result.recordset[0];
        const catResult = await pool.request()
            .input('supplierId', sql.VarChar(50), id)
            .query(`
                SELECT sc.CategoryID AS id, tc.TenderCategoryName AS name
                FROM SupplierCategories sc
                JOIN TenderCategory tc ON sc.CategoryID = tc.TenderCategoryID
                WHERE sc.SupplierID = @supplierId
            `);

        supplier.categories  = catResult.recordset;
        supplier.documents   = supplier.Documents   ? JSON.parse(supplier.Documents)   : [];
        supplier.experiences = supplier.Experiences ? JSON.parse(supplier.Experiences) : [];
        delete supplier.Documents;
        delete supplier.Experiences;

        supplier.companyType = supplier.CompanyTypeID ? { id: supplier.CompanyTypeID, name: supplier.companyTypeName, keyPrefix: supplier.companyTypeKeyPrefix } : null;
        supplier.region      = supplier.RegionID      ? { id: supplier.RegionID,      name: supplier.regionName,      keyPrefix: supplier.regionKeyPrefix }      : null;
        supplier.city        = supplier.CityID        ? { id: supplier.CityID,        name: supplier.cityName }                                                   : null;
        supplier.country     = supplier.CountryID     ? { id: supplier.CountryID,     name: supplier.countryName,     keyPrefix: supplier.countryKeyPrefix }     : null;

        ['companyTypeName','companyTypeKeyPrefix','regionName','regionKeyPrefix','cityName','countryName','countryKeyPrefix']
            .forEach(k => delete supplier[k]);

        res.json(supplier);
    } catch (error) {
        console.error('[GET /api/suppliers/:id] Error:', error);
        res.status(500).json({ message: error.message });
    }
});


// ── PUT /api/suppliers/:id  — supplier updates own profile (or admin) 
router.put('/:id', requireAuth, async (req, res) => {
    const { id } = req.params;

    if (req.user.role !== 'admin' && req.user.userId !== id)
        return res.status(403).json({ message: 'Forbidden: You can only update your own profile' });

    const {
        companyName, tin, companyTypeId,
        contactPerson, designation, phone, address,
        cityId, regionId, countryId, categories,
    } = req.body;

    try {
        const pool = await getPool();

        const existing = await pool.request()
            .input('supplierId', sql.VarChar(50), id)
            .query(`SELECT SupplierID FROM SupplierProfile WHERE SupplierID = @supplierId`);
        if (existing.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        // Email is intentionally not updatable here — it is the login identity.
        await pool.request()
            .input('supplierId',    sql.VarChar(50),       id)
            .input('companyName',   sql.NVarChar(255),     companyName   ?? null)
            .input('tin',           sql.NVarChar(50),      tin           ?? null)
            .input('companyTypeId', sql.VarChar(20),       companyTypeId || null)
            .input('contactPerson', sql.NVarChar(255),     contactPerson ?? null)
            .input('designation',   sql.NVarChar(255),     designation   ?? null)
            .input('phone',         sql.NVarChar(50),      phone         ?? null)
            .input('address',       sql.NVarChar(sql.MAX), address       ?? null)
            .input('cityId',        sql.VarChar(20),       cityId        || null)
            .input('regionId',      sql.VarChar(20),       regionId      || null)
            .input('countryId',     sql.VarChar(20),       countryId     || null)
            .query(`
                UPDATE SupplierProfile SET
                    CompanyName   = @companyName,
                    TIN           = @tin,
                    CompanyTypeID = @companyTypeId,
                    ContactPerson = @contactPerson,
                    Designation   = @designation,
                    Phone         = @phone,
                    Address       = @address,
                    CityID        = @cityId,
                    RegionID      = @regionId,
                    CountryID     = @countryId
                WHERE SupplierID = @supplierId
            `);

        // Replace categories when provided (accepts ids or {id} objects)
        if (Array.isArray(categories)) {
            const ids = categories
                .map(c => (c && typeof c === 'object' ? c.id : c))
                .filter(Boolean);

            await pool.request()
                .input('supplierId', sql.VarChar(50), id)
                .query(`DELETE FROM SupplierCategories WHERE SupplierID = @supplierId`);

            for (const categoryId of ids) {
                await pool.request()
                    .input('supplierId', sql.VarChar(50), id)
                    .input('categoryId', sql.VarChar(20), categoryId)
                    .query(`INSERT INTO SupplierCategories (SupplierID, CategoryID) VALUES (@supplierId, @categoryId)`);
            }
        }

        await logAudit(pool, req, {
            action: 'SUPPLIER_PROFILE_UPDATE', entityType: 'Supplier', entityId: id,
            description: `${req.user.role === 'admin' ? 'Admin' : 'Supplier'} updated profile for supplier ${id}${companyName ? ` (${companyName})` : ''}`,
        });

        res.json({ message: 'Profile updated successfully' });
    } catch (error) {
        console.error('[PUT /api/suppliers/:id] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── PATCH /api/suppliers/:id/status  — admin only 
router.patch('/:id/status', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    const statusMap       = { Pending: 'PS001', Approved: 'PS002', Rejected: 'PS003', Blacklisted: 'PS004' };
    const profileStatusId = statusMap[status];
    if (!profileStatusId) return res.status(400).json({ message: 'Invalid status' });

    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId',      sql.VarChar(50),       id)
            .input('profileStatusId', sql.VarChar(20),       profileStatusId)
            .input('rejectionReason', sql.NVarChar(sql.MAX), rejectionReason || null)
            .query(`
                UPDATE SupplierProfile SET
                    ProfileStatusID = @profileStatusId,
                    RejectionReason = @rejectionReason
                WHERE SupplierID = @supplierId
            `);

        if (result.rowsAffected[0] === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        const updated = await pool.request()
            .input('supplierId', sql.VarChar(50), id)
            .query(`
                SELECT sp.SupplierID AS id, sp.RegistrationNumber AS registrationNumber,
                       sp.CompanyName AS companyName, sp.Email AS email, sp.DateApplied AS dateApplied,
                       ps.ProfileStatusName AS status, sp.RejectionReason AS rejectionReason
                FROM SupplierProfile sp
                JOIN ProfileStatus ps ON sp.ProfileStatusID = ps.ProfileStatusID
                WHERE sp.SupplierID = @supplierId
            `);

        const supplierUserId = await getSupplierUserId(pool, id);
        if (supplierUserId) {
            if (status === 'Approved') {
                await createNotification(pool, {
                    userId: supplierUserId, userType: 'supplier',
                    message: 'Your supplier account has been approved. You can now browse and bid on tenders.',
                    type: 'success', link: '/supplier/dashboard',
                });

                // Send approval email
                try {
                    await sendTemplatedEmail(pool, sql, 'ETT001', updated.recordset[0].email, {
                        supplierName: updated.recordset[0].companyName,
                        orgName:      process.env.ORG_NAME || 'Procurement Portal',
                    });
                } catch (mailErr) {
                    console.error('[mailer] Failed to send approval email:', mailErr.message);
                }

            } else if (status === 'Rejected') {
                await createNotification(pool, {
                    userId: supplierUserId, userType: 'supplier',
                    message: `Your supplier account application was rejected.${rejectionReason ? ' Reason: ' + rejectionReason : ''}`,
                    type: 'error', link: '/supplier/profile',
                });

                // Send rejection email
                try {
                    await sendTemplatedEmail(pool, sql, 'ETT002', updated.recordset[0].email, {
                        supplierName: updated.recordset[0].companyName,
                        orgName:      process.env.ORG_NAME || 'Procurement Portal',
                    });
                } catch (mailErr) {
                    console.error('[mailer] Failed to send rejection email:', mailErr.message);
                }

            } else if (status === 'Blacklisted') {
                await createNotification(pool, {
                    userId: supplierUserId, userType: 'supplier',
                    message: 'Your supplier account has been blacklisted. Please contact the administrator.',
                    type: 'error', link: '#',
                });
            }
        }

        await logAudit(pool, req, {
            action: `SUPPLIER_${status.toUpperCase()}`, entityType: 'Supplier', entityId: id,
            description: `Set supplier ${id} (${updated.recordset[0]?.companyName || ''}) status to ${status}${rejectionReason ? ` — reason: ${rejectionReason}` : ''}`,
        });

        res.json(updated.recordset[0]);
    } catch (error) {
        console.error('[PATCH /api/suppliers/:id/status] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/suppliers/:supplierId/interests 
router.get('/:supplierId/interests', requireAuth, async (req, res) => {
    const { supplierId } = req.params;

    if (req.user.role !== 'admin' && req.user.userId !== supplierId)
        return res.status(403).json({ message: 'Forbidden: You can only access your own profile' });


    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`
                SELECT i.TenderID AS tenderId, t.Title AS tenderTitle, i.InterestDate AS date
                FROM Interests i
                JOIN Tender t ON i.TenderID = t.TenderID
                WHERE i.SupplierID = @supplierId
                ORDER BY i.InterestDate DESC
            `);
        res.json(result.recordset);
    } catch (error) {
        console.error('[GET supplier interests] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/suppliers/:supplierId/experiences 
router.get('/:supplierId/experiences', requireAuth, async (req, res) => {
    const { supplierId } = req.params;

    if (req.user.role !== 'admin' && req.user.userId !== supplierId)
        return res.status(403).json({ message: 'Forbidden: You can only access your own profile' });


    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`
                SELECT Experiences, ExperienceCount, HasExperiences
                FROM SupplierProfile WHERE SupplierID = @supplierId
            `);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        const s = result.recordset[0];
        res.json({
            experiences:     s.Experiences ? JSON.parse(s.Experiences) : [],
            experienceCount: s.ExperienceCount || 0,
            hasExperiences:  s.HasExperiences  || false
        });
    } catch (error) {
        console.error('[GET experiences] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/suppliers/:supplierId/experience-documents 
router.get('/:supplierId/experience-documents', requireAuth, async (req, res) => {
    const { supplierId } = req.params;

    if (req.user.role !== 'admin' && req.user.userId !== supplierId)
        return res.status(403).json({ message: 'Forbidden: You can only access your own profile' });

    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT Experiences FROM SupplierProfile WHERE SupplierID = @supplierId`);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        const experiences = result.recordset[0].Experiences
            ? JSON.parse(result.recordset[0].Experiences)
            : [];

        res.json(
            experiences
                .filter(exp => exp.proofFile)
                .map(exp => ({
                    company:    exp.company,
                    fileName:   exp.proofFile,
                    uploadDate: exp.uploadDate || null,
                    status:     exp.status     || 'Pending'
                }))
        );
    } catch (error) {
        console.error('[GET experience-documents] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/suppliers/:supplierId/documents 
router.get('/:supplierId/documents', requireAuth, async (req, res) => {
    const { supplierId } = req.params;

    if (req.user.role !== 'admin' && req.user.userId !== supplierId)
        return res.status(403).json({ message: 'Forbidden: You can only access your own profile' });

    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT Documents FROM SupplierProfile WHERE SupplierID = @supplierId`);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        const documents       = result.recordset[0].Documents ? JSON.parse(result.recordset[0].Documents) : [];
        const activeDocuments = documents.filter(doc => doc.status !== 'Replaced');

        const documentsWithUrls = activeDocuments.map(doc => {
            const fileName = doc.fileName ? doc.fileName.split('/').pop() : null;
            const baseUrl  = `${req.protocol}://${req.get('host')}`;
            return {
                ...doc,
                downloadUrl: fileName
                    ? `${baseUrl}/api/suppliers/${supplierId}/documents/${fileName}`
                    : null,
                canRenew: doc.status === 'Rejected'
            };
        });

        res.json(documentsWithUrls);
    } catch (error) {
        console.error('[GET supplier documents] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── GET /api/suppliers/:supplierId/documents/:fileName  — serve file 
router.get('/:supplierId/documents/:fileName', requireAuth, async (req, res) => {
    const { supplierId, fileName } = req.params;

    if (req.user.role !== 'admin' && req.user.userId !== supplierId)
        return res.status(403).json({ message: 'Forbidden: You can only access your own profile' });


    try {
        const blobName = `${supplierId}/${fileName}`;
        const file = await downloadFile(blobName);
        if (!file) return res.status(404).json({ message: 'File not found' });

        res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
        if (file.contentLength) res.setHeader('Content-Length', file.contentLength);
        file.stream.pipe(res);
    } catch (error) {
        console.error('[GET document file] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── POST /api/suppliers/:supplierId/upload-documents 
router.post('/:supplierId/upload-documents',
    verifySupplierUploadAccess,
    upload.fields(Object.keys(DOCUMENT_CONFIG).map(name => ({ name, maxCount: 1 }))),
    async (req, res) => {
        const supplierId = req.params.supplierId;
        const files      = req.files;

        if (!supplierId) return res.status(400).json({ message: 'Supplier ID is required' });
        if (!files || Object.keys(files).length === 0)
            return res.status(400).json({ message: 'No files uploaded' });

        try {
            const pool        = await getPool();
            const uploadedDocs = [];

            for (const [key, fileArray] of Object.entries(files)) {
                if (!fileArray || fileArray.length === 0) continue;
                const config = DOCUMENT_CONFIG[key];
                if (!config) continue;

                const file = fileArray[0];
                const blobName = await uploadToBlob(supplierId, file);
                uploadedDocs.push({
                    name:           config.name,
                    fileName:       blobName,
                    docType:        key,
                    status:         'Pending',
                    uploadDate:     new Date().toISOString().split('T')[0],
                    expiryDate:     req.body[`${key}Expiry`] || null,
                    requiresExpiry: config.requiresExpiry
                });
            }

            const existingResult = await pool.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`SELECT Documents, CompanyName FROM SupplierProfile WHERE SupplierID = @supplierId`);

            const existingDocs = existingResult.recordset[0]?.Documents
                ? JSON.parse(existingResult.recordset[0].Documents)
                : [];
            const companyName  = existingResult.recordset[0]?.CompanyName || 'A supplier';
            const mergedDocs   = [...existingDocs, ...uploadedDocs];

            await pool.request()
                .input('supplierId', sql.VarChar(50),       supplierId)
                .input('documents',  sql.NVarChar(sql.MAX), JSON.stringify(mergedDocs))
                .query(`UPDATE SupplierProfile SET Documents = @documents WHERE SupplierID = @supplierId`);

            const adminIds = await getAdminUserIds(pool);
            for (const adminUserId of adminIds) {
                await createNotification(pool, {
                    userId:   adminUserId,
                    userType: 'admin',
                    message:  `${companyName} uploaded ${uploadedDocs.length} document(s) pending verification.`,
                    type:     'info',
                    link:     `/admin/suppliers/${supplierId}/documents`,
                });
            }

            res.status(201).json({
                message:        'Documents uploaded successfully',
                documents:      uploadedDocs,
                totalDocuments: mergedDocs.length
            });
        } catch (error) {
            console.error('[Upload Documents] Error:', error);
            res.status(500).json({ message: error.message });
        }
    }
);

// ── POST /api/suppliers/:supplierId/upload-experiences 
router.post('/:supplierId/upload-experiences',
    verifySupplierUploadAccess,
    upload.fields(Array.from({ length: 10 }, (_, i) => ({ name: `experienceProof${i}`, maxCount: 1 }))),
    async (req, res) => {
        const { supplierId } = req.params;
        try {
            const pool   = await getPool();
            const result = await pool.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`SELECT Experiences FROM SupplierProfile WHERE SupplierID = @supplierId`);

            if (result.recordset.length === 0)
                return res.status(404).json({ message: 'Supplier not found' });

            const experienceCount = parseInt(req.body.experienceCount || '0');
            const experiences     = [];

            for (let i = 0; i < experienceCount; i++) {
                const company   = req.body[`experienceCompany${i}`];
                const fileArray = req.files[`experienceProof${i}`];
                const file      = fileArray?.[0];
                if (company) {
                    experiences.push({
                        company,
                        proofFile:   file ? await uploadToBlob(supplierId, file) : null,
                        uploadDate: new Date().toISOString().split('T')[0],
                        status:     'Pending'
                    });
                }
            }

            await pool.request()
                .input('supplierId',      sql.VarChar(50),       supplierId)
                .input('experiences',     sql.NVarChar(sql.MAX), JSON.stringify(experiences))
                .input('experienceCount', sql.Int,               experiences.length)
                .input('hasExperiences',  sql.Bit,               experiences.length > 0 ? 1 : 0)
                .query(`
                    UPDATE SupplierProfile SET
                        Experiences     = @experiences,
                        ExperienceCount = @experienceCount,
                        HasExperiences  = @hasExperiences
                    WHERE SupplierID = @supplierId
                `);

            res.json({ message: 'Experiences uploaded successfully', count: experiences.length });
        } catch (error) {
            console.error('[Upload Experiences] Error:', error);
            res.status(500).json({ message: error.message });
        }
    }
);

// ── PATCH /:supplierId/experiences/:index/verify  — admin only 
router.patch('/:supplierId/experiences/:index/verify', requireAdmin, async (req, res) => {
    const { supplierId, index }       = req.params;
    const { status, rejectionReason } = req.body;
    const expIndex                    = parseInt(index, 10);

    if (!['Verified', 'Rejected'].includes(status))
        return res.status(400).json({ message: 'Invalid status. Must be Verified or Rejected.' });
    if (isNaN(expIndex) || expIndex < 0)
        return res.status(400).json({ message: 'Invalid experience index.' });

    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT Experiences, CompanyName FROM SupplierProfile WHERE SupplierID = @supplierId`);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        let experiences   = result.recordset[0].Experiences ? JSON.parse(result.recordset[0].Experiences) : [];

        if (expIndex >= experiences.length)
            return res.status(404).json({ message: 'Experience not found at that index' });

        experiences[expIndex] = {
            ...experiences[expIndex],
            status,
            rejectionReason: status === 'Rejected' ? (rejectionReason || null) : undefined,
            verifiedAt: new Date().toISOString(),
        };

        await pool.request()
            .input('supplierId',  sql.VarChar(50),       supplierId)
            .input('experiences', sql.NVarChar(sql.MAX), JSON.stringify(experiences))
            .query(`UPDATE SupplierProfile SET Experiences = @experiences WHERE SupplierID = @supplierId`);

        const supplierUserId = await getSupplierUserId(pool, supplierId);
        if (supplierUserId) {
            const expCompany = experiences[expIndex].company || 'your experience';
            await createNotification(pool, {
                userId:   supplierUserId,
                userType: 'supplier',
                message:  status === 'Verified'
                    ? `Your experience proof for "${expCompany}" has been verified and approved.`
                    : `Your experience proof for "${expCompany}" was rejected.${rejectionReason ? ' Reason: ' + rejectionReason : ' Please re-upload.'}`,
                type: status === 'Verified' ? 'success' : 'error',
                link: '/supplier/profile',
            });
        }

        await logAudit(pool, req, {
            action: status === 'Verified' ? 'EXPERIENCE_VERIFY' : 'EXPERIENCE_REJECT',
            entityType: 'Supplier', entityId: supplierId,
            description: `${status} experience #${expIndex} ("${experiences[expIndex].company || ''}") for supplier ${supplierId}${rejectionReason ? ` — reason: ${rejectionReason}` : ''}`,
        });

        res.json({ message: `Experience ${status.toLowerCase()} successfully` });
    } catch (error) {
        console.error('[PATCH experience verify] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── PATCH /:supplierId/documents/:docType/verify  — admin only 
router.patch('/:supplierId/documents/:docType/verify', requireAdmin, async (req, res) => {
    const { supplierId, docType }     = req.params;
    const { status, rejectionReason } = req.body;

    try {
        const pool        = await getPool();
        const transaction = new sql.Transaction(pool);
        await transaction.begin();

        try {
            const result = await transaction.request()
                .input('supplierId', sql.VarChar(50), supplierId)
                .query(`
                    SELECT Documents
                    FROM SupplierProfile WITH (UPDLOCK, HOLDLOCK)
                    WHERE SupplierID = @supplierId
                `);

            if (result.recordset.length === 0) {
                await transaction.rollback();
                return res.status(404).json({ message: 'Supplier not found' });
            }

            let documents = result.recordset[0].Documents
                ? JSON.parse(result.recordset[0].Documents)
                : [];

            documents = documents.map(doc =>
                (doc.docType === docType && doc.status === 'Pending')
                    ? { ...doc, status, rejectionReason: status === 'Rejected' ? rejectionReason : undefined, verifiedAt: new Date().toISOString() }
                    : doc
            );

            await transaction.request()
                .input('supplierId', sql.VarChar(50),       supplierId)
                .input('documents',  sql.NVarChar(sql.MAX), JSON.stringify(documents))
                .query(`UPDATE SupplierProfile SET Documents = @documents WHERE SupplierID = @supplierId`);

            await transaction.commit();
        } catch (err) {
            await transaction.rollback();
            throw err;
        }

        // Notifications are non-critical — run outside transaction
        const supplierUserId = await getSupplierUserId(pool, supplierId);
        if (supplierUserId) {
            const docName = DOCUMENT_CONFIG[docType]?.name || docType;
            await createNotification(pool, {
                userId: supplierUserId, userType: 'supplier',
                message: status === 'Verified'
                    ? `Your document "${docName}" has been verified and approved.`
                    : `Your document "${docName}" was rejected.${rejectionReason ? ' Reason: ' + rejectionReason : ' Please re-upload.'}`,
                type: status === 'Verified' ? 'success' : 'error',
                link: '/supplier/documents',
            });
        }

        await logAudit(pool, req, {
            action: status === 'Verified' ? 'DOCUMENT_VERIFY' : 'DOCUMENT_REJECT',
            entityType: 'Document', entityId: supplierId,
            description: `${status} document "${DOCUMENT_CONFIG[docType]?.name || docType}" for supplier ${supplierId}${rejectionReason ? ` — reason: ${rejectionReason}` : ''}`,
        });

        res.json({ message: `Document ${status.toLowerCase()} successfully` });
    } catch (error) {
        console.error('[Verify Document] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

// ── POST /:supplierId/documents/:docType/renew — supplier uploads new version of an existing document (e.g. after expiry, rejection, or for renewal)
router.post('/:supplierId/documents/:docType/renew', requireAuth, upload.single('document'), async (req, res) => {
    const { supplierId, docType } = req.params;
    const { expiryDate }          = req.body;
    const file = req.file;

    if (req.user.role !== 'admin' && req.user.userId !== supplierId)
        return res.status(403).json({ message: 'Forbidden: You can only renew your own documents' });


    if (!file) return res.status(400).json({ message: 'No file uploaded' });
    const config = DOCUMENT_CONFIG[docType];
    if (!config) return res.status(400).json({ message: 'Invalid document type' });

    if (config.requiresExpiry) {
        if (!expiryDate) return res.status(400).json({ message: 'Expiry date is required for this document type' });

        const parsedExpiry = new Date(expiryDate);
        if (isNaN(parsedExpiry.getTime()))
            return res.status(400).json({ message: 'Invalid expiry date' });

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (parsedExpiry < today)
            return res.status(400).json({ message: 'Expiry date cannot be in the past' });
    }

    try {
        const pool   = await getPool();
        const result = await pool.request()
            .input('supplierId', sql.VarChar(50), supplierId)
            .query(`SELECT Documents, CompanyName FROM SupplierProfile WHERE SupplierID = @supplierId`);

        if (result.recordset.length === 0)
            return res.status(404).json({ message: 'Supplier not found' });

        let documents     = result.recordset[0].Documents ? JSON.parse(result.recordset[0].Documents) : [];
        const companyName = result.recordset[0].CompanyName;

        const blobName = await uploadToBlob(supplierId, file);
        documents = documents.map(doc =>
            (doc.docType === docType && doc.status !== 'Replaced')
                ? { ...doc, status: 'Replaced', replacedAt: new Date().toISOString(), replacedBy: blobName }
                : doc
        );

        const newDocument = {
            name:           config.name,
            fileName:       blobName,
            docType,
            status:         'Pending',
            uploadDate:     new Date().toISOString().split('T')[0],
            expiryDate:     expiryDate || null,
            requiresExpiry: config.requiresExpiry,
            isRenewal:      true
        };
        documents.push(newDocument);

        await pool.request()
            .input('supplierId', sql.VarChar(50),       supplierId)
            .input('documents',  sql.NVarChar(sql.MAX), JSON.stringify(documents))
            .query(`UPDATE SupplierProfile SET Documents = @documents WHERE SupplierID = @supplierId`);

        const adminIds = await getAdminUserIds(pool);
        for (const adminUserId of adminIds) {
            await createNotification(pool, {
                userId:   adminUserId,
                userType: 'admin',
                message:  `${companyName} renewed their "${config.name}" document and it requires verification.`,
                type:     'info',
                link:     `/admin/suppliers/${supplierId}/documents`,
            });
        }

        res.json({ message: 'Document renewed successfully', document: newDocument });
    } catch (error) {
        console.error('[Renew Document] Error:', error);
        res.status(500).json({ message: error.message });
    }
});

module.exports = router;