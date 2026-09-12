const NAME_MAX_LENGTH = 255;
const COPY_SUFFIX = / \(copy(?: \d+)?\)$/;

/**
 * Builds "<name> (copy)" for a duplicated item, incrementing to "(copy 2)", "(copy 3)", ...
 * while the candidate is already taken in the same scope. An existing "(copy N)" suffix on
 * the original is stripped first so copies of copies do not stack suffixes.
 */
module.exports.nextCopyName = (name, takenNames = []) => {
    const taken = new Set(takenNames);
    const base = name.replace(COPY_SUFFIX, "");
    for (let i = 1; ; i++) {
        const suffix = i === 1 ? " (copy)" : ` (copy ${i})`;
        const candidate = base.slice(0, NAME_MAX_LENGTH - suffix.length) + suffix;
        if (!taken.has(candidate)) return candidate;
    }
};
