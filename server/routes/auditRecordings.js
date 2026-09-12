const { Router } = require("express");
const Session = require("../models/Session");
const Account = require("../models/Account");
const { authenticate } = require("../middlewares/auth");
const auditController = require("../controllers/audit");
const { createRecordingShareValidation } = require("../validations/audit");
const { validateSchema } = require("../utils/schema");
const { sendRecording } = require("../utils/recordingService");
const logger = require("../utils/logger");

const app = Router();

// Downloads must work from a plain link (no headers), so a session token may also be passed as
// ?sessionToken= like the SFTP download routes. Anything else goes through the regular middleware.
const authenticateFlexible = async (req, res, next) => {
    const { sessionToken } = req.query;
    if (req.header("authorization") || typeof sessionToken !== "string" || !sessionToken) return authenticate(req, res, next);

    const session = await Session.findOne({ where: { token: sessionToken } });
    if (!session) return res.status(401).json({ message: "The provided token is not valid" });

    const user = await Account.findByPk(session.accountId);
    if (!user) return res.status(401).json({ message: "The account associated to the token is not registered" });

    await Session.update({ lastActivity: new Date(), ip: req.ip }, { where: { id: session.id } });
    req.session = session;
    req.user = user;
    next();
};

const parseAuditLogId = (value) => {
    const id = Number.parseInt(value, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * GET /audit/recordings/{auditLogId}/download
 * @summary Download Session Recording File
 * @description Downloads the raw, gzip-compressed recording file of an audit log entry as an attachment named "<entry>-<date>.cast.gz" (terminal sessions, asciicast v2) or "<entry>-<date>.guac.gz" (RDP/VNC sessions, Guacamole protocol dump). Requires the same access as playback: the owner of a personal recording, or the "org.audit.recordings" permission for organization recordings. The session token may be passed as the ?sessionToken= query parameter instead of the Authorization header so the URL works as a plain link. Every download is written to the audit log as "recording.download".
 * @tags Audit
 * @produces application/gzip, application/json
 * @security BearerAuth
 * @param {number} auditLogId.path.required - The audit log entry that owns the recording
 * @param {string} sessionToken.query - Session token, alternative to the Authorization header
 * @return {file} 200 - Gzip-compressed recording file
 * @return {object} 400 - Invalid audit log id
 * @return {object} 401 - Missing or invalid credentials
 * @return {object} 403 - Access denied to the recording
 * @return {object} 404 - Recording not found
 * @return {object} 500 - Internal server error
 */
app.get("/:auditLogId/download", authenticateFlexible, async (req, res) => {
    const auditLogId = parseAuditLogId(req.params.auditLogId);
    if (!auditLogId) return res.status(400).json({ message: "Invalid audit log id" });

    try {
        const result = await auditController.getRecording(req.user.id, auditLogId);
        if (result.code) return res.status(result.code).json({ message: result.message });

        auditController.logRecordingAccess(req, result.auditLog, auditController.AUDIT_ACTIONS.RECORDING_DOWNLOAD, { fileName: result.fileName });
        sendRecording(res, result, { download: true });
    } catch (error) {
        logger.error("Error in recording download route", { auditLogId, error: error.message });
        if (!res.headersSent) res.status(500).json({ message: "An error occurred while downloading the recording" });
    }
});

/**
 * POST /audit/recordings/{auditLogId}/share
 * @summary Create Recording Share Link
 * @description Creates a signed, time-limited link that lets anyone who has it play or download this single recording without logging in. The token is stateless (an HMAC over the audit log id and expiry, keyed from ENCRYPTION_KEY), so nothing is stored server side and individual links cannot be revoked early: a link stops working when it expires or when the recording itself is deleted (retention cleanup). Requires the same access as playback. Creating a link is written to the audit log as "recording.share".
 * @tags Audit
 * @produces application/json
 * @security BearerAuth
 * @param {number} auditLogId.path.required - The audit log entry that owns the recording
 * @param {CreateRecordingShare} request.body - Link lifetime in seconds (default 24 hours, maximum 7 days)
 * @return {object} 200 - Share token, absolute player URL, absolute file URL and expiry timestamp
 * @return {object} 400 - Invalid audit log id or lifetime
 * @return {object} 403 - Access denied to the recording
 * @return {object} 404 - Recording not found
 * @return {object} 500 - Internal server error
 */
app.post("/:auditLogId/share", authenticate, async (req, res) => {
    const auditLogId = parseAuditLogId(req.params.auditLogId);
    if (!auditLogId) return res.status(400).json({ message: "Invalid audit log id" });

    try {
        if (validateSchema(res, createRecordingShareValidation, req.body || {})) return;

        const result = await auditController.createRecordingShare(req, auditLogId, req.body?.expiresIn);
        if (result.code) return res.status(result.code).json({ message: result.message });

        const origin = `${req.protocol}://${req.get("host")}`;
        res.json({
            token: result.token,
            expiresAt: result.expiresAt,
            url: `${origin}/share/recording/${result.token}`,
            downloadUrl: `${origin}/api/share/recording/${result.token}`,
        });
    } catch (error) {
        logger.error("Error in recording share route", { auditLogId, error: error.message });
        res.status(500).json({ message: "An error occurred while creating the share link" });
    }
});

module.exports = app;
