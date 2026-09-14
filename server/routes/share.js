const { Router } = require("express");
const SessionManager = require("../lib/SessionManager");
const Entry = require("../models/Entry");
const Organization = require("../models/Organization");
const Account = require("../models/Account");
const { getPrimaryProtocol } = require("../utils/entryProtocols");
const auditController = require("../controllers/audit");
const { sendRecording } = require("../utils/recordingService");
const logger = require("../utils/logger");

const app = Router();

/**
 * GET /share/recording/{token}
 * @summary Get Shared Session Recording
 * @description Streams a single session recording through a signed share link created with POST /audit/recordings/{auditLogId}/share. No login is required and nothing but the recording file itself is exposed. By default the raw gzip file is sent as a download; pass ?inline=true to receive the decoded stream (Content-Encoding: gzip) for in-browser playback, with the format in the X-Recording-Type header ("cast" or "guac"). Links are stateless and cannot be revoked individually: they stop working when they expire or when the recording is deleted.
 * @tags Share
 * @produces application/gzip, application/json, application/octet-stream
 * @param {string} token.path.required - Signed share token
 * @param {string} inline.query - Set to "true" to stream the decoded recording for playback instead of a file download
 * @return {file} 200 - Recording file
 * @return {object} 404 - Unknown or tampered token, or recording no longer available
 * @return {object} 410 - Share link expired
 */
app.get("/recording/:token", async (req, res) => {
    try {
        const result = await auditController.getSharedRecording(req.params.token);
        if (result.code) return res.status(result.code).json({ message: result.message });

        sendRecording(res, result, { download: req.query.inline !== "true" });
    } catch (error) {
        logger.error("Error in shared recording route", { error: error.message });
        if (!res.headersSent) res.status(500).json({ message: "An error occurred while retrieving the recording" });
    }
});

/**
 * GET /share/{shareId}
 * @summary Get Shared Session Details
 * @description Retrieves information about a shared session by its unique share ID. Returns session details including the associated entry information, permissions, and organization context. This endpoint is used to access sessions that have been shared by other users.
 * @tags Share
 * @produces application/json
 * @param {string} shareId.path.required - The unique identifier of the shared session
 * @return {object} 200 - Shared session details including server info, permissions, and organization
 * @return {object} 404 - Shared session or associated entry not found
 */
app.get("/:shareId", async (req, res) => {
    const session = SessionManager.getByShareId(req.params.shareId);
    if (!session) return res.status(404).json({ error: "Shared session not found" });

    const entry = await Entry.findByPk(session.entryId, {
        attributes: ["id", "name", "type", "icon", "config", "organizationId"],
    });
    if (!entry) return res.status(404).json({ error: "Entry not found" });

    const orgName = entry.organizationId
        ? (await Organization.findByPk(entry.organizationId, { attributes: ["name"] }))?.name
        : null;

    const owner = await Account.findByPk(session.accountId, { attributes: ["preferences"] });
    const ownerTerminal = owner?.preferences?.terminal || {};

    res.json({
        id: session.sessionId,
        server: {
            id: entry.id,
            name: entry.name,
            type: entry.type,
            icon: entry.icon,
            renderer: session.configuration.renderer || "terminal",
            protocol: session.configuration.protocol || getPrimaryProtocol(entry),
        },
        writable: session.shareWritable,
        type: session.configuration.type || undefined,
        organizationId: entry.organizationId || null,
        organizationName: orgName,
        fontFamily: ownerTerminal.fontFamily || undefined,
        fontSize: ownerTerminal.fontSize || undefined,
    });
});

module.exports = app;
