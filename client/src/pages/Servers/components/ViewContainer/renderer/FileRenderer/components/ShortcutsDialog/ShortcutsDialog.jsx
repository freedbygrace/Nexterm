import { DialogProvider } from "@/common/components/Dialog";
import { useTranslation } from "react-i18next";
import "./styles.sass";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
const mod = isMac ? "⌘" : "Ctrl";

/** Every shortcut the file list handles, grouped the way the user thinks about them. */
const GROUPS = [
    {
        key: "navigation",
        shortcuts: [
            { keys: ["↑", "↓"], key: "move" },
            { keys: ["Home", "End"], key: "firstLast" },
            { keys: ["Enter"], key: "open" },
            { keys: ["Backspace"], key: "up" },
            { keys: ["Esc"], key: "clearSelection" },
        ],
    },
    {
        key: "selection",
        shortcuts: [
            { keys: [mod, "A"], key: "selectAll" },
            { keys: ["Space"], key: "toggle" },
        ],
    },
    {
        key: "files",
        shortcuts: [
            { keys: ["F2"], key: "rename" },
            { keys: ["Delete"], key: "delete" },
            { keys: [mod, "C"], key: "copy" },
            { keys: [mod, "X"], key: "cut" },
            { keys: [mod, "V"], key: "paste" },
            { keys: [mod, "Shift", "N"], key: "newFolder" },
            { keys: [mod, "Alt", "N"], key: "newFile" },
        ],
    },
    {
        key: "other",
        shortcuts: [
            { keys: [mod, "Shift", "C"], key: "copyPath" },
            { keys: [mod, "T"], key: "openTerminal" },
            { keys: ["?"], key: "shortcuts" },
        ],
    },
];

export const ShortcutsDialog = ({ open, onClose }) => {
    const { t } = useTranslation();

    return (
        <DialogProvider open={open} onClose={onClose}>
            <div className="shortcuts-dialog">
                <h2>{t("servers.fileManager.shortcuts.title")}</h2>

                <div className="shortcut-groups">
                    {GROUPS.map(group => (
                        <div className="shortcut-group" key={group.key}>
                            <h3>{t(`servers.fileManager.shortcuts.groups.${group.key}`)}</h3>
                            {group.shortcuts.map(shortcut => (
                                <div className="shortcut-row" key={shortcut.key}>
                                    <span className="shortcut-label">{t(`servers.fileManager.shortcuts.actions.${shortcut.key}`)}</span>
                                    <span className="shortcut-keys">
                                        {shortcut.keys.map(key => <kbd key={key}>{key}</kbd>)}
                                    </span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        </DialogProvider>
    );
};

export default ShortcutsDialog;
