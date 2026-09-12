const crypto = require("crypto");

const DEFAULT_SHARE_TTL = 24 * 60 * 60;
const MAX_SHARE_TTL = 7 * 24 * 60 * 60;
const MIN_SHARE_TTL = 60;

const INVALID = { valid: false, reason: "invalid" };

// Derives a dedicated signing key from ENCRYPTION_KEY so recording share tokens never reuse the
// data-encryption key directly. Tokens are stateless: "<auditLogId>.<expiresAtUnix>.<base64url hmac>".
const getSigningKey = () => {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error("ENCRYPTION_KEY not found in environment variables");
    return crypto.createHmac("sha256", Buffer.from(key, "hex")).update("nexterm:recording-share").digest();
};

const sign = (payload) => crypto.createHmac("sha256", getSigningKey()).update(payload).digest("base64url");

const clampShareTtl = (expiresIn) => {
    const ttl = Number.parseInt(expiresIn, 10);
    if (!Number.isFinite(ttl)) return DEFAULT_SHARE_TTL;
    return Math.min(Math.max(ttl, MIN_SHARE_TTL), MAX_SHARE_TTL);
};

const createRecordingShareToken = (auditLogId, expiresIn = DEFAULT_SHARE_TTL) => {
    const id = Number.parseInt(auditLogId, 10);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid audit log id");

    const expiresAtUnix = Math.floor(Date.now() / 1000) + clampShareTtl(expiresIn);
    const payload = `${id}.${expiresAtUnix}`;
    return { token: `${payload}.${sign(payload)}`, expiresAt: new Date(expiresAtUnix * 1000) };
};

const verifyRecordingShareToken = (token, now = Date.now()) => {
    if (typeof token !== "string" || token.length > 80) return INVALID;

    const parts = token.split(".");
    if (parts.length !== 3) return INVALID;

    const [id, exp, signature] = parts;
    if (!/^[1-9]\d{0,11}$/.test(id) || !/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return INVALID;

    const expected = Buffer.from(sign(`${id}.${exp}`));
    const provided = Buffer.from(signature);
    if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) return INVALID;

    const expiresAtUnix = Number.parseInt(exp, 10);
    if (expiresAtUnix * 1000 <= now) return { valid: false, reason: "expired" };

    return { valid: true, auditLogId: Number.parseInt(id, 10), expiresAt: new Date(expiresAtUnix * 1000) };
};

module.exports = {
    DEFAULT_SHARE_TTL, MAX_SHARE_TTL, MIN_SHARE_TTL,
    clampShareTtl, createRecordingShareToken, verifyRecordingShareToken,
};
