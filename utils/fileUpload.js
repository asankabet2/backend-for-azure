const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');

// Configure storage
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const supplierId = req.params.supplierId || req.body.supplierId || req.body.supplierid;

        if (!supplierId) {
            return cb(new Error('Supplier ID is required for file upload'));
        }

        const uploadPath = path.join(__dirname, '../uploads/suppliers', supplierId);
        await fs.ensureDir(uploadPath);
        cb(null, uploadPath);
    },

    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const fieldName = file.fieldname;
        const ext = path.extname(file.originalname);
        cb(null, `${fieldName}-${timestamp}${ext}`);
    }
});

// File filter
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'image/jpeg', 'image/png', 'image/jpg', 'image/gif',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only images, PDFs, and documents are allowed.'));
    }
};

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: fileFilter
});

// Helper to delete a file
async function deleteFile(filePath) {
    try {
        const fullPath = path.join(__dirname, '../uploads/suppliers', filePath);
        if (await fs.pathExists(fullPath)) {
            await fs.remove(fullPath);
            console.log(`[File] Deleted: ${fullPath}`);
            return true;
        }
    } catch (error) {
        console.error(`[File] Delete error: ${error.message}`);
        return false;
    }
}

// Helper to get file info
async function getFileInfo(filePath) {
    try {
        const fullPath = path.join(__dirname, '../uploads/suppliers', filePath);
        if (await fs.pathExists(fullPath)) {
            const stats = await fs.stat(fullPath);
            return {
                exists: true,
                size: stats.size,
                modified: stats.mtime
            };
        }
    } catch (error) {
        console.error(`[File] Get info error: ${error.message}`);
    }
    return { exists: false };
}

module.exports = { upload, deleteFile, getFileInfo };