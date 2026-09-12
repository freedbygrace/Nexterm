const Snippet = require("../models/Snippet");
const { Op } = require("sequelize");
const stateBroadcaster = require("../lib/StateBroadcaster");
const { hasResourcePermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const { nextCopyName } = require("../utils/duplicate");

const getWhereClause = (id, accountId, organizationId) => organizationId
    ? { id, organizationId }
    : { id, accountId, organizationId: null };

const canManage = (accountId, organizationId) =>
    hasResourcePermission(accountId, organizationId, Permission.SNIPPETS_MANAGE);

const getScopeWhere = (accountId, organizationId) => organizationId
    ? { organizationId }
    : { accountId, organizationId: null, sourceId: null };

const listScopeOrdered = (accountId, organizationId) =>
    Snippet.findAll({ where: getScopeWhere(accountId, organizationId), order: [['sortOrder', 'ASC'], ['id', 'ASC']] });

const renumber = (all) =>
    Promise.all(all.map((s, i) => Snippet.update({ sortOrder: i + 1 }, { where: { id: s.id } })));

module.exports.createSnippet = async (accountId, configuration) => {
    if (!(await canManage(accountId, configuration.organizationId)))
        return { code: 403, message: "You don't have permission to manage snippets" };

    const maxSortOrder = await Snippet.max('sortOrder', {
        where: getScopeWhere(accountId, configuration.organizationId)
    }) || 0;
    const snippet = await Snippet.create({
        ...configuration,
        accountId: configuration.organizationId ? null : accountId,
        sortOrder: maxSortOrder + 1
    });

    stateBroadcaster.broadcast("SNIPPETS", { accountId, organizationId: configuration.organizationId });

    return snippet;
};

module.exports.duplicateSnippet = async (accountId, snippetId, { name, organizationId: targetOrganizationId } = {}, organizationId = null) => {
    const original = await Snippet.findOne({
        where: {
            [Op.or]: [getWhereClause(snippetId, accountId, organizationId), { id: snippetId, sourceId: { [Op.ne]: null } }],
        },
    });
    if (!original) return { code: 404, message: "Snippet does not exist" };

    const targetOrgId = targetOrganizationId === undefined ? original.organizationId : (targetOrganizationId || null);
    if (!(await canManage(accountId, targetOrgId)))
        return { code: 403, message: "You don't have permission to manage snippets" };

    const siblings = await listScopeOrdered(accountId, targetOrgId);
    const copyName = name || nextCopyName(original.name, siblings.map(s => s.name));

    const copy = await Snippet.create({
        name: copyName,
        command: original.command,
        description: original.description,
        osFilter: original.osFilter,
        organizationId: targetOrgId,
        accountId: targetOrgId ? null : accountId,
        sourceId: null,
        sortOrder: (siblings[siblings.length - 1]?.sortOrder || 0) + 1,
    });

    const originalIdx = siblings.findIndex(s => s.id === original.id);
    if (originalIdx !== -1) {
        siblings.splice(originalIdx + 1, 0, copy);
        await renumber(siblings);
        copy.sortOrder = originalIdx + 2;
    }

    stateBroadcaster.broadcast("SNIPPETS", { accountId, organizationId: targetOrgId });

    return copy;
};

module.exports.deleteSnippet = async (accountId, snippetId, organizationId = null) => {
    if (!(await canManage(accountId, organizationId)))
        return { code: 403, message: "You don't have permission to manage snippets" };
    const snippet = await Snippet.findOne({ where: getWhereClause(snippetId, accountId, organizationId) });
    if (!snippet) return { code: 404, message: "Snippet does not exist" };
    if (snippet.sourceId) return { code: 403, message: "Cannot delete source-synced snippets" };
    await Snippet.destroy({ where: { id: snippetId } });

    stateBroadcaster.broadcast("SNIPPETS", { accountId, organizationId: snippet.organizationId });
};

module.exports.editSnippet = async (accountId, snippetId, configuration, organizationId = null) => {
    if (!(await canManage(accountId, organizationId)))
        return { code: 403, message: "You don't have permission to manage snippets" };
    const snippet = await Snippet.findOne({ where: getWhereClause(snippetId, accountId, organizationId) });
    if (!snippet) return { code: 404, message: "Snippet does not exist" };
    if (snippet.sourceId) return { code: 403, message: "Cannot edit source-synced snippets" };
    const { organizationId: _, accountId: __, ...updateData } = configuration;
    await Snippet.update(updateData, { where: { id: snippetId } });

    stateBroadcaster.broadcast("SNIPPETS", { accountId, organizationId: snippet.organizationId });
};

module.exports.repositionSnippet = async (accountId, snippetId, { targetId }, organizationId = null) => {
    if (!targetId || parseInt(snippetId) === parseInt(targetId)) return { success: true };
    if (!(await canManage(accountId, organizationId)))
        return { code: 403, message: "You don't have permission to manage snippets" };

    const snippet = await Snippet.findOne({ where: getWhereClause(snippetId, accountId, organizationId) });
    if (!snippet) return { code: 404, message: "Snippet does not exist" };
    if (snippet.sourceId) return { code: 403, message: "Cannot reorder source-synced snippets" };
    
    const all = await listScopeOrdered(accountId, organizationId);

    const srcIdx = all.findIndex(s => s.id === parseInt(snippetId));
    const tgtIdx = all.findIndex(s => s.id === parseInt(targetId));
    if (srcIdx === -1 || tgtIdx === -1) return { code: 404, message: "Snippet not found" };

    all.splice(tgtIdx, 0, all.splice(srcIdx, 1)[0]);
    await renumber(all);

    stateBroadcaster.broadcast("SNIPPETS", { accountId, organizationId: snippet.organizationId });

    return { success: true };
};

module.exports.getSnippet = async (accountId, snippetId, organizationId = null) => {
    const snippet = await Snippet.findOne({ where: getWhereClause(snippetId, accountId, organizationId) });
    return snippet || { code: 404, message: "Snippet does not exist" };
};

module.exports.listSnippets = async (accountId, organizationId = null) =>
    Snippet.findAll({ where: getScopeWhere(accountId, organizationId), order: [["sortOrder", "ASC"]] });

module.exports.listAllAccessibleSnippets = async (accountId, organizationIds = []) => {
    return Snippet.findAll({ 
        where: {
            [Op.or]: [
                { accountId, organizationId: null, sourceId: null },
                ...(organizationIds.length > 0 ? [{ organizationId: { [Op.in]: organizationIds } }] : [])
            ]
        },
        order: [["sortOrder", "ASC"]]
    });
};

module.exports.listSourceSnippets = async (sourceId) => 
    Snippet.findAll({ where: { sourceId }, order: [["sortOrder", "ASC"]] });

module.exports.listAllSourceSnippets = async () => 
    Snippet.findAll({ where: { sourceId: { [Op.ne]: null } }, order: [["sortOrder", "ASC"]] });