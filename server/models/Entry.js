const Sequelize = require("sequelize");
const logger = require("../utils/logger");
const db = require("../utils/database");

module.exports = db.define("entries", {
    accountId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
            model: "accounts",
            key: "id",
        },
        onDelete: "CASCADE",
    },
    organizationId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
            model: "organizations",
            key: "id",
        },
        onDelete: "CASCADE",
    },
    folderId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
            model: "folders",
            key: "id",
        },
        onDelete: "SET NULL",
    },
    integrationId: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
            model: "integrations",
            key: "id",
        },
        onDelete: "SET NULL",
    },
    type: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    renderer: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    name: {
        type: Sequelize.STRING,
        allowNull: false,
    },
    icon: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    position: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
        allowNull: false,
    },
    status: {
        type: Sequelize.STRING,
        allowNull: true,
    },
    config: {
        type: Sequelize.JSON,
        allowNull: true,
    },
    // Per-protocol reachability written by the status checker: { checkedAt, protocols: { ssh: "online", ... } }
    statusDetails: {
        type: Sequelize.JSON,
        allowNull: true,
    },
}, {
    freezeTableName: true,
    timestamps: true,
    hooks: {
        afterFind: (entries) => {
            const parseJsonField = (entry, field) => {
                if (entry && entry[field] && typeof entry[field] === 'string') {
                    try {
                        entry[field] = JSON.parse(entry[field]);
                    } catch (e) {
                        logger.error(`Failed to parse Entry ${field}`, { entryId: entry.id, error: e.message });
                    }
                }
            };
            const parseConfig = (entry) => {
                parseJsonField(entry, 'config');
                parseJsonField(entry, 'statusDetails');
            };
            
            if (Array.isArray(entries)) {
                entries.forEach(parseConfig);
            } else if (entries) {
                parseConfig(entries);
            }
        },
    },
});
