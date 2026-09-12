/**
 * Adds `statusDetails` to entries: the per-protocol reachability result of the status checker
 * (`{ checkedAt, protocols: { ssh: "online", rdp: "offline" } }`). Stored as JSON (TEXT on SQLite).
 */
module.exports = {
    async up(queryInterface, Sequelize) {
        const tables = await queryInterface.showAllTables();
        if (!tables.includes("entries")) return;

        const columns = await queryInterface.describeTable("entries");
        if (columns.statusDetails) return;

        await queryInterface.addColumn("entries", "statusDetails", {
            type: Sequelize.JSON,
            allowNull: true,
        });
    },
};
