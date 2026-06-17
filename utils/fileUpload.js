const multer = require('multer');
const path = require('path');
const { containerClient } = require('../helpers/blobStorage');

// Multer just parses into memory now — no disk writes
const storage = multer.memoryStorage();

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
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter
});


async function uploadToBlob(supplierId, file) {
    if (!supplierId) {
        throw new Error('Supplier ID is required for file upload');
    }
    if (!file) {
        throw new Error('No file provided');
    }

    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    const blobName = `${supplierId}/${file.fieldname}-${timestamp}${ext}`;

    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadData(file.buffer, {
        blobHTTPHeaders: { blobContentType: file.mimetype }
    });

    return blobName;
}

// Delete a blob given the blob name returned by uploadToBlob
async function deleteFile(blobName) {
    try {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const result = await blockBlobClient.deleteIfExists();
        if (result.succeeded) {
            console.log(`[Blob] Deleted: ${blobName}`);
        }
        return result.succeeded;
    } catch (error) {
        console.error(`[Blob] Delete error: ${error.message}`);
        return false;
    }
}

// Get blob info given the blob name
async function getFileInfo(blobName) {
    try {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        const exists = await blockBlobClient.exists();
        if (!exists) return { exists: false };

        const props = await blockBlobClient.getProperties();
        return {
            exists: true,
            size: props.contentLength,
            modified: props.lastModified
        };
    } catch (error) {
        console.error(`[Blob] Get info error: ${error.message}`);
        return { exists: false };
    }
}

async function downloadFile(blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    const exists = await blockBlobClient.exists();
    if (!exists) return null;

    const downloadResponse = await blockBlobClient.download();
    return {
        stream: downloadResponse.readableStreamBody,
        contentType: downloadResponse.contentType,
        contentLength: downloadResponse.contentLength
    };
}

module.exports = { upload, uploadToBlob, deleteFile, getFileInfo, downloadFile };