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

module.exports.repositionServerValidation = Joi.object({
    targetId: Joi.number().allow(null).optional(),
    placement: Joi.string().valid('before', 'after').required(),
    folderId: Joi.number().allow(null).optional(),
    organizationId: Joi.number().allow(null).optional()
});