const jwt = require('jsonwebtoken');

// ── verifyToken / requireAuth 

function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    const token      = authHeader && authHeader.split(' ')[1];

    if (!token)
        return res.status(401).json({ message: 'Access denied. No token provided.' });

    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (error) {
        if (error.name === 'TokenExpiredError')
            return res.status(401).json({ message: 'Token expired. Please login again.' });
        return res.status(403).json({ message: 'Invalid token.' });
    }
}

// ── verifyAdmin / requireAdmin 

function verifyAdmin(req, res, next) {
    verifyToken(req, res, () => {
        if (req.user.role !== 'admin')
            return res.status(403).json({ message: 'Access denied. Admin only.' });
        next();
    });
}

// ── verifySupplier 

function verifySupplier(req, res, next) {
    verifyToken(req, res, () => {
        if (req.user.role !== 'supplier')
            return res.status(403).json({ message: 'Access denied. Supplier only.' });
        next();
    });
}

// Aliases used throughout all route files
const requireAuth     = verifyToken;
const requireAdmin    = verifyAdmin;
const requireSupplier = verifySupplier;

module.exports = {
    verifyToken,
    verifyAdmin,
    verifySupplier,
    requireAuth,
    requireAdmin,
    requireSupplier,
};