const Sequelize = require("sequelize");
const db = require("../utils/database");

/**
 * A bootstrap token for enrolling a host.
 *
 * Each token owns one generated SSH identity: the private key stays in Nexterm (encrypted, like every
 * other identity), and the matching public key is what the enrollment script installs on the target.
 * The token itself is the only credential the target ever sees, so it is scoped, expiring and
 * countable, and can be revoked.
 */
module.exports = db.define("enrollment_tokens", {
    token: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
    },
    name: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    /** Creator; enrolled entries and the identity are owned by them unless organizationId is set. */
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "accounts", key: "id" },
        onDelete: "CASCADE",
    },
    organizationId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "organizations", key: "id" },
        onDelete: "CASCADE",
    },
    /** Identity holding the generated key pair. */
    identityId: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "identities", key: "id" },
        onDelete: "CASCADE",
    },
    /** Folder enrolled entries are created in. */
    folderId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "folders", key: "id" },
        onDelete: "SET NULL",
    },
    /** Remote user the key is installed for, and the username of the identity. */
    username: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "root",
    },
    /** null = unlimited; otherwise the token stops working after this many successful enrollments. */
    maxUses: {
        type: Sequelize.INTEGER,
        allowNull: true,
    },
    uses: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
    },
    expiresAt: {
        type: Sequelize.DATE,
        allowNull: true,
    },
    revokedAt: {
        type: Sequelize.DATE,
        allowNull: true,
    },
    /** Whether a successful enrollment creates (or updates) a server entry. */
    /** "key": install the public key in authorized_keys. "certificate": trust the scope's SSH CA. */
    method: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "key",
    },
    createEntries: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
    },
    lastUsedAt: {
        type: Sequelize.DATE,
        allowNull: true,
    },
}, {
    freezeTableName: true,
    timestamps: true,
});
