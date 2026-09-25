const Sequelize = require("sequelize");
const db = require("../utils/database");
const { decrypt, encrypt } = require("../utils/encryption");

/**
 * An SSH user certificate authority, one per scope (an account's personal space or an organization).
 *
 * Hosts that trust its public key (sshd's TrustedUserCAKeys) accept any certificate it signs for a
 * matching user name. Nexterm signs one, valid for minutes, every time an identity linked to it
 * connects - so there is no long-lived certificate to leak, and disabling the identity stops access
 * immediately. The private key is encrypted at rest like every credential.
 */
module.exports = db.define("ssh_certificate_authorities", {
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: true,
    },
    organizationId: {
        type: Sequelize.INTEGER,
        allowNull: true,
    },
    publicKey: {
        type: Sequelize.TEXT,
        allowNull: false,
    },
    privateKey: {
        type: Sequelize.VIRTUAL,
        get() {
            return decrypt(this.getDataValue("privateKeyEncrypted"), this.getDataValue("privateKeyIV"),
                this.getDataValue("privateKeyAuthTag"));
        },
        set(value) {
            const encrypted = encrypt(value);
            this.setDataValue("privateKeyEncrypted", Buffer.from(encrypted.encrypted, "hex"));
            this.setDataValue("privateKeyIV", encrypted.iv);
            this.setDataValue("privateKeyAuthTag", encrypted.authTag);
        },
    },
    privateKeyEncrypted: {
        type: Sequelize.BLOB,
        allowNull: false,
    },
    privateKeyIV: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    privateKeyAuthTag: {
        type: Sequelize.STRING,
        allowNull: false,
    },
}, {
    freezeTableName: true,
    timestamps: true,
});
