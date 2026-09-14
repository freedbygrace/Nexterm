/**
 * Splits the two jobs the notes field was doing.
 *
 * Notes are a scratchpad (now rendered as Markdown) and are no longer shown in the list; the one-line
 * blurb under an entry's name is a description of its own. Entries that had "show note in list" on
 * keep their line: its first line becomes the description, and the old flag goes away.
 */
module.exports = {
    async up(queryInterface) {
        const tables = await queryInterface.showAllTables();
        if (!tables.includes("entries")) return;

        const [rows] = await queryInterface.sequelize.query(
            "SELECT id, config FROM entries WHERE type = 'server' AND config IS NOT NULL",
        );

        for (const row of rows) {
            let config;
            try {
                config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
            } catch {
                continue;
            }
            if (!config || config.showNoteInList === undefined) continue;

            const firstLine = String(config.notes || "").split(/\r?\n/)[0].trim();
            if (config.showNoteInList && firstLine && !config.description) {
                config.description = firstLine.slice(0, 500);
                config.showDescriptionInList = true;
            }
            delete config.showNoteInList;

            await queryInterface.sequelize.query(
                "UPDATE entries SET config = :config WHERE id = :id",
                { replacements: { config: JSON.stringify(config), id: row.id } },
            );
        }
    },
};
