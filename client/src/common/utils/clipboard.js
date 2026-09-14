/**
 * Copies text to the clipboard.
 *
 * `navigator.clipboard` only exists in secure contexts, and Nexterm is regularly reached over plain http
 * on a LAN address, so fall back to a hidden textarea and `execCommand("copy")` there.
 *
 * @returns {Promise<boolean>} whether the text made it to the clipboard.
 */
export const copyToClipboard = async (text) => {
    if (!text) return false;

    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const area = document.createElement("textarea");
            area.value = text;
            area.setAttribute("readonly", "");
            area.style.cssText = "position:fixed;left:-9999px;top:-9999px";
            document.body.appendChild(area);
            area.select();
            const copied = document.execCommand("copy");
            document.body.removeChild(area);
            return copied;
        } catch {
            return false;
        }
    }
};
