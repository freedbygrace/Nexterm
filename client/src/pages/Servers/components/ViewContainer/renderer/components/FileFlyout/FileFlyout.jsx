import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiChevronRight, mdiFolderOpen, mdiRefresh } from "@mdi/js";
import { deleteRequest, postRequest } from "@/common/utils/RequestUtil.js";
import { getBrowserId, getTabId } from "@/common/utils/ConnectionUtil.js";
import FileRenderer from "@/pages/Servers/components/ViewContainer/renderer/FileRenderer";
import "./styles.sass";

const MIN_WIDTH = 280;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 420;
const WIDTH_KEY = "nexterm-file-flyout-width";

const storedWidth = () => {
    try {
        const value = Number.parseInt(localStorage.getItem(WIDTH_KEY), 10);
        return Number.isFinite(value) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, value)) : DEFAULT_WIDTH;
    } catch {
        return DEFAULT_WIDTH;
    }
};

/**
 * The file manager for a terminal session, docked beside it instead of living in its own tab.
 *
 * It runs on an SFTP session of its own - the engine needs a separate channel for it - opened the
 * first time the panel is shown, kept while the panel is retracted, and closed together with the
 * terminal. Retracting only hides it, so coming back is instant and the directory is where it was
 * left.
 */
export const FileFlyout = ({ session, open, onClose, getStartPath, setOpenFileEditors, onOpenTerminal }) => {
    const { t } = useTranslation();
    const [companion, setCompanion] = useState(null);
    const [error, setError] = useState(null);
    const [width, setWidth] = useState(storedWidth);
    const [resizing, setResizing] = useState(false);

    const companionRef = useRef(null);
    const openedRef = useRef(false);

    useEffect(() => {
        if (!open || openedRef.current) return;
        openedRef.current = true;

        let cancelled = false;
        (async () => {
            try {
                const created = await postRequest("/connections", {
                    entryId: session.server.id,
                    identityId: session.identity,
                    type: "sftp",
                    startPath: getStartPath?.() || undefined,
                    tabId: getTabId(),
                    browserId: getBrowserId(),
                });

                // The terminal went away while the session was being created.
                if (cancelled) {
                    deleteRequest(`/connections/${created.sessionId}`).catch(() => {});
                    return;
                }

                const data = { ...session, id: created.sessionId, type: "sftp", protocol: "sftp" };
                companionRef.current = data;
                setCompanion(data);
            } catch (err) {
                console.error("Failed to open the file panel", err);
                if (!cancelled) {
                    openedRef.current = false;
                    setError(err?.message || t("servers.fileFlyout.error"));
                }
            }
        })();

        return () => { cancelled = true; };
    }, [open, session, getStartPath, t]);

    // The panel's session belongs to this terminal, so it goes when the terminal does.
    useEffect(() => () => {
        const id = companionRef.current?.id;
        companionRef.current = null;
        if (id) deleteRequest(`/connections/${id}`).catch(() => {});
    }, []);

    const startResize = useCallback((event) => {
        event.preventDefault();
        const right = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect().right
            ?? window.innerWidth;
        setResizing(true);

        const onMove = (move) => setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, right - move.clientX)));

        const onUp = () => {
            setResizing(false);
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            setWidth(current => {
                try { localStorage.setItem(WIDTH_KEY, String(current)); } catch { /* private mode */ }
                return current;
            });
        };

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    }, []);

    // Nothing is mounted until the panel is opened for the first time.
    if (!open && !companionRef.current && !error) return null;

    return (
        <div className={`file-flyout${open ? "" : " retracted"}${resizing ? " resizing" : ""}`}
             style={open ? { width: `${width}px` } : undefined}>
            <div className="file-flyout-resizer" onMouseDown={startResize} />
            <div className="file-flyout-header">
                <div className="file-flyout-title">
                    <Icon path={mdiFolderOpen} />
                    <span>{t("servers.fileFlyout.title")}</span>
                </div>
                <button type="button" className="file-flyout-retract" onClick={onClose}
                        title={t("servers.fileFlyout.retract")}>
                    <Icon path={mdiChevronRight} />
                </button>
            </div>

            <div className="file-flyout-body">
                {error ? (
                    <div className="file-flyout-error">
                        <p>{error}</p>
                        <button type="button" onClick={() => { setError(null); openedRef.current = false; }}>
                            <Icon path={mdiRefresh} />
                            <span>{t("servers.fileFlyout.retry")}</span>
                        </button>
                    </div>
                ) : companion ? (
                    <FileRenderer session={companion} isActive={open}
                                  setOpenFileEditors={setOpenFileEditors}
                                  onOpenTerminal={onOpenTerminal}
                                  disconnectFromServer={onClose} />
                ) : (
                    <p className="file-flyout-loading">{t("servers.fileFlyout.connecting")}</p>
                )}
            </div>
        </div>
    );
};

export default FileFlyout;
