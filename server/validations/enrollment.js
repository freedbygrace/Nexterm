const Joi = require("joi");

module.exports.createEnrollmentValidation = Joi.object({
    name: Joi.string().trim().min(1).max(100).required(),
    organizationId: Joi.number().integer().allow(null).optional(),
    folderId: Joi.number().integer().allow(null).optional(),
    /** Remote account the key is installed for. */
    username: Joi.string().trim().min(1).max(64).optional(),
    /** null = the token can be reused without limit. */
    maxUses: Joi.number().integer().min(1).max(10000).allow(null).optional(),
    /** null = the token never expires. */
    lifetimeDays: Joi.number().integer().min(1).max(365).allow(null).optional(),
    createEntries: Joi.boolean().optional(),
    /** "key" installs the public key; "certificate" makes sshd trust the scope's SSH certificate authority. */
    method: Joi.string().valid("key", "certificate").optional(),
});

/**
 * What an enrolling host may tell us about itself. Everything here is written by the target, so it is
 * kept to the few fields needed to build a connection and bounded in size.
 */
module.exports.enrollmentReportValidation = Joi.object({
    hostname: Joi.string().trim().max(255).allow("").optional(),
    address: Joi.string().trim().max(255).allow("").optional(),
    os: Joi.string().trim().max(200).allow("").optional(),
    port: Joi.number().integer().min(1).max(65535).optional(),
    /** Set when the host has RDP listening (Windows Remote Desktop, xrdp). */
    rdpPort: Joi.number().integer().min(1).max(65535).optional(),
    username: Joi.string().trim().max(64).allow("").optional(),
}).unknown(false);
