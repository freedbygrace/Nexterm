/**
 * GNU-style JSON formatter.
 *
 * `JSON.stringify(value, null, 4)` puts every opening brace at the end of the previous line and keeps
 * short arrays on one line. Exported documents are meant to be read and hand-edited, so this formatter
 * writes them the way GNU-style C is written instead:
 *
 *   - every opening `{` / `[` sits on its own line, aligned with the key it belongs to
 *   - every value sits on its own line, so arrays never collapse
 *   - four spaces per level
 *   - empty objects and arrays stay compact (`{}` / `[]`)
 *
 * ```json
 * {
 *     "entries":
 *     [
 *         {
 *             "name": "build-box",
 *             "protocols":
 *             {
 *                 "ssh":
 *                 {
 *                     "enabled": true
 *                 }
 *             }
 *         }
 *     ]
 * }
 * ```
 */

const INDENT = "    ";

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Values JSON.stringify would drop entirely (undefined, functions, symbols) must not produce a line. */
const isOmitted = (value) => value === undefined || typeof value === "function" || typeof value === "symbol";

const formatValue = (value, depth) => {
    if (value === null) return "null";

    if (Array.isArray(value)) {
        const items = value.map(item => (isOmitted(item) ? "null" : formatValue(item, depth + 1)));
        if (items.length === 0) return "[]";
        const pad = INDENT.repeat(depth + 1);
        return `[\n${items.map(item => pad + item).join(",\n")}\n${INDENT.repeat(depth)}]`;
    }

    if (isPlainObject(value)) {
        if (typeof value.toJSON === "function") return formatValue(value.toJSON(), depth);

        const keys = Object.keys(value).filter(key => !isOmitted(value[key]));
        if (keys.length === 0) return "{}";
        const pad = INDENT.repeat(depth + 1);
        const lines = keys.map(key => {
            const child = value[key];
            const nested = Array.isArray(child) ? child.length > 0 : isPlainObject(child) && Object.keys(child).length > 0;
            // Containers start on the next line (GNU style); scalars stay on the key's line.
            return nested
                ? `${pad}${JSON.stringify(key)}:\n${pad}${formatValue(child, depth + 1)}`
                : `${pad}${JSON.stringify(key)}: ${formatValue(child, depth + 1)}`;
        });
        return `{\n${lines.join(",\n")}\n${INDENT.repeat(depth)}}`;
    }

    return JSON.stringify(value);
};

/** Formats `value` as a GNU-style JSON document with a trailing newline. */
module.exports.formatJson = (value) => `${formatValue(value, 0)}\n`;
