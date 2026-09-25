const { DataTypes } = require("sequelize");

/**
 * SSH user certificate authorities (see models/SshCertificateAuthority.js), the identities they
 * certify, and the enrollment method that installs a CA instead of a key.
 */
module.exports = {
    async up(queryInterface) {
        const tables = await queryInterface.showAllTables();

        if (!tables.includes("ssh_certificate_authorities")) {
            await queryInterface.createTable("ssh_certificate_authorities", {
                id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true, allowNull: false },
                accountId: { type: DataTypes.INTEGER, allowNull: true },
                organizationId: { type: DataTypes.INTEGER, allowNull: true },
                publicKey: { type: DataTypes.TEXT, allowNull: false },
                privateKeyEncrypted: { type: DataTypes.BLOB, allowNull: false },
                privateKeyIV: { type: DataTypes.STRING, allowNull: false },
                privateKeyAuthTag: { type: DataTypes.STRING, allowNull: false },
                createdAt: { type: DataTypes.DATE, allowNull: false },
                updatedAt: { type: DataTypes.DATE, allowNull: false },
            });
        }

        if (tables.includes("identities")) {
            const columns = await queryInterface.describeTable("identities");
            if (!columns.certificateAuthorityId) {
                await queryInterface.addColumn("identities", "certificateAuthorityId", {
                    type: DataTypes.INTEGER,
                    allowNull: true,
                });
            }
        }

        if (tables.includes("enrollment_tokens")) {
            const columns = await queryInterface.describeTable("enrollment_tokens");
            if (!columns.method) {
                await queryInterface.addColumn("enrollment_tokens", "method", {
                    type: DataTypes.STRING,
                    allowNull: false,
                    defaultValue: "key",
                });
            }
        }
    },
};
