const { DataTypes } = require("sequelize");

/** Bootstrap tokens for enrolling hosts (see models/EnrollmentToken.js). */
module.exports = {
    async up(queryInterface) {
        const tables = await queryInterface.showAllTables();
        if (tables.includes("enrollment_tokens")) return;

        await queryInterface.createTable("enrollment_tokens", {
            id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
            token: { type: DataTypes.STRING, allowNull: false, unique: true },
            name: { type: DataTypes.STRING, allowNull: false },
            accountId: { type: DataTypes.INTEGER, allowNull: false },
            organizationId: { type: DataTypes.INTEGER, allowNull: true },
            identityId: { type: DataTypes.INTEGER, allowNull: false },
            folderId: { type: DataTypes.INTEGER, allowNull: true },
            username: { type: DataTypes.STRING, allowNull: false, defaultValue: "root" },
            maxUses: { type: DataTypes.INTEGER, allowNull: true },
            uses: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
            expiresAt: { type: DataTypes.DATE, allowNull: true },
            revokedAt: { type: DataTypes.DATE, allowNull: true },
            createEntries: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
            lastUsedAt: { type: DataTypes.DATE, allowNull: true },
            createdAt: { type: DataTypes.DATE, allowNull: false },
            updatedAt: { type: DataTypes.DATE, allowNull: false },
        });

        await queryInterface.addIndex("enrollment_tokens", ["token"], { unique: true });
    },
};
