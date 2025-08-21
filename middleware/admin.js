// middleware/admin.js
function requireAdmin(req, res, next) {
    // This middleware must run *after* requireAuth
    if (!req.user || !req.user.is_admin) {
        return res.status(403).json({ error: 'Forbidden: Administrator access required.' });
    }
    next();
}

module.exports = { requireAdmin };