
function generateId(prefix) {
    const ts = Date.now().toString(36);
    const rnd = Math.random().toString(36).slice(2, 6);
    return `${prefix}-${ts}-${rnd}`.toUpperCase();
}

module.exports = { generateId };