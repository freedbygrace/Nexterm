const Joi = require("joi");
const { PROTOCOLS } = require("../utils/entryProtocols");

const protocolEntryValidation = Joi.object({
    enabled: Joi.boolean().required(),
    port: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
    identityId: Joi.number().integer().allow(null).optional(),
});

const configValidation = Joi.object({
    protocol: Joi.string().valid(...PROTOCOLS).optional(),
    protocols: Joi.object().pattern(Joi.string().valid(...PROTOCOLS), protocolEntryValidation).optional(),
    ip: Joi.string().optional(),
    port: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
    keyboardLayout: Joi.string().optional(),
    monitoringEnabled: Joi.boolean().optional(),
    nodeName: Joi.string().optional(),
    vmid: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
    rdpSecurity: Joi.string().valid("any", "nla", "tls", "rdp", "vmconnect").allow("").optional(),
    jumpHosts: Joi.array().items(Joi.number()).optional(),
    macAddress: Joi.string().pattern(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/).allow("").optional(),
    wakeOnLanEnabled: Joi.boolean().optional(),
    wolBroadcastAddress: Joi.string().ip({ version: ['ipv4'] }).allow("").optional(),
}).unknown(true);

module.exports.createServerValidation = Joi.object({
    name: Joi.string().required(),
    folderId: Joi.number().allow(null).optional(),
    folderPath: Joi.alternatives().try(
        Joi.string().max(1000),
        Joi.array().items(Joi.string().min(1).max(50)).max(20),
    ).optional(),
    organizationId: Joi.number().allow(null).optional(),
    icon: Joi.string().optional(),
    type: Joi.string().valid("server").optional().default("server"),
    renderer: Joi.string().optional(),
    identities: Joi.array().items(Joi.number()).optional(),
    config: configValidation.required()
});

module.exports.updateServerValidation = Joi.object({
    name: Joi.string().optional(),
    folderId: Joi.number().allow(null).optional(),
    folderPath: Joi.alternatives().try(
        Joi.string().max(1000),
        Joi.array().items(Joi.string().min(1).max(50)).max(20),
    ).optional(),
    organizationId: Joi.number().allow(null).optional(),
    icon: Joi.string().optional(),
    type: Joi.string().valid("server", "pve-shell", "pve-lxc", "pve-qemu").optional(),
    renderer: Joi.string().optional(),
    identities: Joi.array().items(Joi.number()).optional(),
    config: configValidation
});

const folderPathValidation = Joi.alternatives().try(
    Joi.string().max(1000),
    Joi.array().items(Joi.string().min(1).max(50)).max(20),
);

// An identity given by id or by name (names are matched case-insensitively among the caller's identities).
const identityReference = Joi.alternatives().try(Joi.number().integer().positive(), Joi.string().trim().min(1).max(100));

const bulkProtocolValidation = Joi.alternatives().try(
    Joi.boolean(),
    Joi.object({
        enabled: Joi.boolean().optional(),
        port: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
        identity: identityReference.optional(),
    }),
);

/** One row of POST /entries/import/bulk. Validated per row so a bad row never fails the whole import. */
module.exports.bulkImportEntryValidation = Joi.object({
    name: Joi.string().trim().min(1).max(200).required(),
    host: Joi.string().trim().min(1).max(500).required(),
    folderPath: folderPathValidation.allow("", null).optional(),
    protocols: Joi.alternatives().try(
        Joi.array().items(Joi.string().valid(...PROTOCOLS)).min(1).unique(),
        Joi.object().pattern(Joi.string().valid(...PROTOCOLS), bulkProtocolValidation).min(1),
    ).required(),
    primary: Joi.string().valid(...PROTOCOLS).optional(),
    identities: Joi.array().items(identityReference).max(50).optional(),
    tags: Joi.array().items(Joi.string().trim().min(1).max(50)).max(50).optional(),
    notes: Joi.string().allow("").max(10000).optional(),
    icon: Joi.string().max(100).optional(),
    monitoring: Joi.boolean().optional(),
    // Jump hosts may be given as entry names in an import; they are resolved to ids per row.
    config: configValidation.keys({ jumpHosts: Joi.array().items(Joi.alternatives().try(Joi.number(), Joi.string().max(200))).optional() }).optional(),
});

module.exports.bulkImportValidation = Joi.object({
    // The body of an export document is accepted as-is, so version/exportedAt are tolerated.
    version: Joi.number().optional(),
    exportedAt: Joi.string().optional(),
    entries: Joi.array().items(Joi.object().unknown(true)).min(1).max(500).required(),
    folderId: Joi.number().allow(null).optional(),
    organizationId: Joi.number().allow(null).optional(),
    dryRun: Joi.boolean().optional().default(false),
    updateExisting: Joi.boolean().optional().default(false),
});

module.exports.repositionServerValidation = Joi.object({
    targetId: Joi.number().allow(null).optional(),
    placement: Joi.string().valid('before', 'after').required(),
    folderId: Joi.number().allow(null).optional(),
    organizationId: Joi.number().allow(null).optional()
});