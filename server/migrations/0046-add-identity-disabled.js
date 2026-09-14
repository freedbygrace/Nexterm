const { DataTypes } = require("sequelize");

/**
 * Lets an identity be disabled without deleting it.
 *
 * Nexterm holds the private key, so disabling one is what actually cuts off access: every session that
 * would use it is refused, while the identity and its history stay intact and can be re-enabled.
 */
module.exports = {
    async up(queryInterface) {
        const tables = await queryInterface.showAllTables();
        if (!tables.includes("identities")) return;

        const columns = await queryInterface.describeTable("identities");
        if (columns.disabled) return;

        await queryInterface.addColumn("identities", "disabled", {
            type: DataTypes.BOOLEAN,
            allowNull: false,
            defaultValue: false,
        });
    },
};
