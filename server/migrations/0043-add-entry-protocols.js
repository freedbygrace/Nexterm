const logger = require("../utils/logger");
const { normalizeServerConfig } = require("../utils/entryProtocols");

/**
 * Backfills `config.protocols` for existing "server" entries so that every entry carries an
 * explicit per-protocol map (see utils/entryProtocols.js). Legacy single-protocol entries become
 * `{ [protocol]: { enabled: true, port } }` (plus SFTP for SSH entries).
 */
module.exports = {
    async up(queryInterface) {
        const tables = await queryInterface.showAllTables();
        if (!tables.includes("entries")) return;

        const entries = await queryInterface.sequelize.query(
            "SELECT id, config FROM entries WHERE type = 'server'",
            { type: queryInterface.sequelize.QueryTypes.SELECT },
        );

        let updated = 0;
        for (const entry of entries) {
            let config = entry.config;
            if (typeof config === "string") {
                try {
                    config = JSON.parse(config);
                } catch (e) {
                    logger.error("Failed to parse entry config during protocol migration", { entryId: entry.id, error: e.message });
                    continue;
                }
            }
            if (!config || typeof config !== "object") continue;
            if (config.protocols && typeof config.protocols === "object") continue;
            if (!config.protocol) continue;

            normalizeServerConfig(config, { type: "server" });

            await queryInterface.sequelize.query(
                "UPDATE entries SET config = :config WHERE id = :id",
                { replacements: { config: JSON.stringify(config), id: entry.id } },
            );
            updated++;
        }

        if (updated) logger.info(`Backfilled protocol maps for ${updated} server entries`);
    },
};
