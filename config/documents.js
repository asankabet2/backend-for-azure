// config/documents.js
const DOCUMENT_CONFIG = {
    companyProfile: { name: 'Company Profile / Brochure', fileName: 'company-profile', required: false, requiresExpiry: false },
    certificateOfIncorporation: { name: 'Certificate of Incorporation', fileName: 'certificate-incorporation', required: true, requiresExpiry: false },
    graClearance: { name: 'GRA Clearance Certificate', fileName: 'gra-clearance', required: true, requiresExpiry: true },
    ssnitClearance: { name: 'SSNIT Clearance Certificate', fileName: 'ssnit-clearance', required: true, requiresExpiry: true },
    fdaCertificate: { name: 'FDA Certificate', fileName: 'fda-certificate', required: false, requiresExpiry: true },
    ppaCertificate: { name: 'PPA Certificate', fileName: 'ppa-certificate', required: false, requiresExpiry: true },
    introductionLetter: { name: 'Introduction Letter', fileName: 'introduction-letter', required: true, requiresExpiry: false },
    auditedFinancials: { name: 'Audited Financial Statements (past 2 years)', fileName: 'audited-financials', required: true, requiresExpiry: false },
    cvDocument: { name: 'CV with Past Experiences', fileName: 'cv', required: true, requiresExpiry: false },
};

module.exports = { DOCUMENT_CONFIG };