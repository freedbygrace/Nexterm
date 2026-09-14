const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const { authenticate } = require("../middlewares/auth");
const { validateSchema } = require("../utils/schema");
const {
    createEnrollmentToken,
    listEnrollmentTokens,
    revokeEnrollmentToken,
    getEnrollmentScript,
    completeEnrollment,
} = require("../controllers/enrollment");
const { createEnrollmentValidation, enrollmentReportValidation } = require("../validations/enrollment");
const logger = require("../utils/logger");

const app = Router();

/**
 * The script and callback endpoints carry no session: the token in the URL is the only credential, so
 * they are rate limited per IP to make guessing a 32-byte token pointless rather than merely hard.
 */
const enrollRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    message: { code: 429, message: "Too many enrollment requests. Please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * POST /enrollment
 * @summary Create an Enrollment Token
 * @description Generates an SSH key pair and a bootstrap token for it. The private key is stored as an identity and
 * never leaves Nexterm; the token is returned once and yields a shell command that installs the public key on a host
 * and, unless disabled, creates the matching connection. Tokens are scoped to the caller or an organization, expire,
 * and can be limited to a number of uses.
 * @tags Enrollment
 * @produces application/json
 * @security BearerAuth
 * @param {CreateEnrollment} request.body.required - Name, scope, target user, lifetime and use limit
 * @return {object} 200 - The token, its public key and the command to run
 * @return {object} 403 - Permission denied
 */
app.post("/", authenticate, async (req, res) => {
    if (validateSchema(res, createEnrollmentValidation, req.body)) return;

    const result = await createEnrollmentToken(req.user.id, req.body);
    if (result?.code) return res.status(result.code).json(result);

    const origin = `${req.protocol}://${req.get("host")}`;
    res.json({ ...result, command: `curl -fsSL ${origin}/api/enroll/${result.token} | sh` });
});

/**
 * GET /enrollment
 * @summary List Enrollment Tokens
 * @description Lists the enrollment tokens of the caller, or of an organization. The token secrets are never returned
 * again after creation; each entry carries its public key, fingerprint, usage count and expiry.
 * @tags Enrollment
 * @produces application/json
 * @security BearerAuth
 * @param {number} organizationId.query - List the tokens of this organization instead of personal ones
 * @return {array<object>} 200 - Enrollment tokens
 */
app.get("/", authenticate, async (req, res) => {
    const organizationId = req.query.organizationId ? Number.parseInt(req.query.organizationId, 10) : null;
    res.json(await listEnrollmentTokens(req.user.id, organizationId));
});

/**
 * DELETE /enrollment/{id}
 * @summary Revoke an Enrollment Token
 * @description Revokes an enrollment token so its command stops working. Hosts already enrolled keep working: the key
 * stays installed and the identity is untouched.
 * @tags Enrollment
 * @produces application/json
 * @security BearerAuth
 * @param {number} id.path.required - The enrollment token to revoke
 * @return {object} 200 - Token revoked
 * @return {object} 404 - Token not found
 */
app.delete("/:id", authenticate, async (req, res) => {
    const result = await revokeEnrollmentToken(req.user.id, Number.parseInt(req.params.id, 10));
    if (result?.code) return res.status(result.code).json(result);
    res.json(result);
});

module.exports = app;

/** The unauthenticated half, mounted separately at /api/enroll. */
const publicApp = Router();

/**
 * GET /enroll/{token}
 * @summary Enrollment Script
 * @description Returns the shell script that installs this token's public key on the host running it and reports the
 * host back. Meant to be piped into sh. Requires no login: the token is the credential, and it stops working when it
 * expires, is used up or is revoked.
 * @tags Enrollment
 * @produces text/plain
 * @param {string} token.path.required - The enrollment token
 * @return {string} 200 - A POSIX shell script
 * @return {object} 404 - Unknown token
 * @return {object} 410 - Expired, used up or revoked
 */
publicApp.get("/:token", enrollRateLimiter, async (req, res) => {
    const origin = `${req.protocol}://${req.get("host")}`;
    const result = await getEnrollmentScript(req.params.token, origin);

    if (result?.code) {
        // Piped into a shell, so the failure has to be legible in a terminal as well.
        res.status(result.code).type("text/plain").send(`#!/bin/sh\necho 'nexterm: ${result.message}' >&2\nexit 1\n`);
        return;
    }

    res.type("text/plain").send(result.script);
});

/**
 * POST /enroll/{token}/callback
 * @summary Report an Enrolled Host
 * @description Called by the enrollment script once the key is installed. Creates or updates the connection for the
 * reported host and counts one use of the token. Requires no login; the token is the credential.
 * @tags Enrollment
 * @produces application/json
 * @param {string} token.path.required - The enrollment token
 * @param {EnrollmentReport} request.body.required - Hostname, address, OS and SSH port of the host
 * @return {object} 200 - Connection created or updated
 * @return {object} 410 - Expired, used up or revoked
 */
publicApp.post("/:token/callback", enrollRateLimiter, async (req, res) => {
    if (validateSchema(res, enrollmentReportValidation, req.body || {})) return;

    try {
        const result = await completeEnrollment(req.params.token, req.body || {}, req.ip);
        if (result?.code) return res.status(result.code).json(result);
        res.json(result);
    } catch (error) {
        logger.error("Enrollment callback failed", { error: error.message });
        res.status(500).json({ message: "Enrollment failed" });
    }
});

module.exports.publicApp = publicApp;
