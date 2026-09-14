import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiCheckCircleOutline, mdiEyeOutline, mdiNoteEditOutline, mdiPencilOutline, mdiSync } from "@mdi/js";
import { getRequest, patchRequest } from "@/common/utils/RequestUtil.js";
import Markdown from "@/common/components/Markdown";
import Tooltip from "@/common/components/Tooltip";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import "./styles.sass";

const SAVE_DEBOUNCE_MS = 800;

const STATUS = { IDLE: "idle", DIRTY: "dirty", SAVING: "saving", SAVED: "saved", ERROR: "error" };

export const NotesRenderer = ({ session }) => {
    const { t } = useTranslation();
    const { getServerById } = useContext(ServerContext);

    const server = session?.server;
    const entryId = server?.id;
    const serverFromContext = getServerById?.(entryId);

    const initialNotes = serverFromContext?.notes ?? server?.notes ?? "";

    const [value, setValue] = useState(initialNotes);
    // Notes are Markdown; the pane flips between writing and reading it.
    const [preview, setPreview] = useState(false);
    const [status, setStatus] = useState(STATUS.IDLE);

    const textareaRef = useRef(null);
    const entrySnapshotRef = useRef(null);
    const saveTimerRef = useRef(null);
    const inFlightRef = useRef(false);
    const pendingPatchRef = useRef(null);
    const lastSavedRef = useRef({ notes: initialNotes });
    const valueRef = useRef(initialNotes);

    useEffect(() => {
        let cancelled = false;
        if (!entryId) return;

        getRequest("entries/" + entryId).then(entry => {
            if (cancelled || !entry) return;
            entrySnapshotRef.current = entry;
            const remoteNotes = entry?.config?.notes ?? "";
            if (remoteNotes !== lastSavedRef.current.notes && valueRef.current === lastSavedRef.current.notes) {
                valueRef.current = remoteNotes;
                setValue(remoteNotes);
                lastSavedRef.current.notes = remoteNotes;
            }
        }).catch(() => {});

        return () => { cancelled = true; };
    }, [entryId]);

    const persist = useCallback(async (patch) => {
        if (!entryId) return;
        if (inFlightRef.current) {
            pendingPatchRef.current = { ...(pendingPatchRef.current || {}), ...patch };
            return;
        }

        if (!entrySnapshotRef.current) {
            try {
                const entry = await getRequest("entries/" + entryId);
                entrySnapshotRef.current = entry;
            } catch {
                setStatus(STATUS.ERROR);
                return;
            }
        }

        const entry = entrySnapshotRef.current;
        if (!entry) {
            setStatus(STATUS.ERROR);
            return;
        }

        inFlightRef.current = true;
        setStatus(STATUS.SAVING);

        const nextConfig = { ...(entry.config || {}), ...patch };

        try {
            await patchRequest("entries/" + entryId, {
                name: entry.name,
                icon: entry.icon,
                config: nextConfig,
                identities: entry.identities || [],
            });
            entrySnapshotRef.current = { ...entry, config: nextConfig };
            if ("notes" in patch) lastSavedRef.current.notes = patch.notes;
            setStatus(STATUS.SAVED);
        } catch (err) {
            console.error("Failed to save notes", err);
            setStatus(STATUS.ERROR);
        } finally {
            inFlightRef.current = false;
            const queued = pendingPatchRef.current;
            pendingPatchRef.current = null;
            if (queued) {
                const drained = {};
                if ("notes" in queued && queued.notes !== lastSavedRef.current.notes) drained.notes = queued.notes;
                if (Object.keys(drained).length > 0) persist(drained);
            }
        }
    }, [entryId]);

    const scheduleNotesSave = useCallback((next) => {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            if (next !== lastSavedRef.current.notes) persist({ notes: next });
        }, SAVE_DEBOUNCE_MS);
    }, [persist]);

    const flushNotesSave = useCallback(() => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        if (value !== lastSavedRef.current.notes) persist({ notes: value });
    }, [value, persist]);

    useEffect(() => () => {
        if (saveTimerRef.current) {
            clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        const latest = valueRef.current;
        if (latest !== lastSavedRef.current.notes) persist({ notes: latest });
    }, []);

    const handleChange = (e) => {
        const next = e.target.value;
        valueRef.current = next;
        setValue(next);
        setStatus(next === lastSavedRef.current.notes ? STATUS.IDLE : STATUS.DIRTY);
        scheduleNotesSave(next);
    };

    const handleKeyDown = (e) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
            e.preventDefault();
            e.stopPropagation();
            flushNotesSave();
        }
    };

    // Leaving the editor is a good moment to write, so the preview always shows what is saved.
    const togglePreview = () => {
        if (!preview) flushNotesSave();
        setPreview(!preview);
    };

    const renderStatus = () => {
        switch (status) {
            case STATUS.SAVING:
                return (
                    <span className="notes-status saving">
                        <Icon path={mdiSync} />
                        {t("servers.notesPanel.status.saving")}
                    </span>
                );
            case STATUS.SAVED:
                return (
                    <span className="notes-status saved">
                        <Icon path={mdiCheckCircleOutline} />
                        {t("servers.notesPanel.status.saved")}
                    </span>
                );
            case STATUS.DIRTY:
                return (
                    <span className="notes-status dirty">
                        {t("servers.notesPanel.status.unsaved")}
                    </span>
                );
            case STATUS.ERROR:
                return (
                    <span className="notes-status error">
                        {t("servers.notesPanel.status.error")}
                    </span>
                );
            default:
                return null;
        }
    };

    return (
        <div className="notes-renderer">
            <div className="notes-header">
                <div className="notes-title">
                    <Icon path={mdiNoteEditOutline} />
                    <h3>{t("servers.notesPanel.title")}</h3>
                </div>
                <div className="notes-actions">
                    <Tooltip text={t(preview ? "servers.notesPanel.editTooltip" : "servers.notesPanel.previewTooltip")} delay={600}>
                        <button type="button" className={`notes-preview-btn${preview ? " active" : ""}`} onClick={togglePreview}>
                            <Icon path={preview ? mdiPencilOutline : mdiEyeOutline} />
                            <span>{t(preview ? "servers.notesPanel.edit" : "servers.notesPanel.preview")}</span>
                        </button>
                    </Tooltip>
                    {renderStatus()}
                </div>
            </div>
            {preview ? (
                value.trim()
                    ? <Markdown text={value} className="notes-preview" />
                    : <p className="notes-preview-empty">{t("servers.notesPanel.previewEmpty")}</p>
            ) : (
                <textarea
                    ref={textareaRef}
                    className="notes-textarea"
                    value={value}
                    onChange={handleChange}
                    onBlur={flushNotesSave}
                    onKeyDown={handleKeyDown}
                    placeholder={t("servers.notesPanel.placeholder")}
                    spellCheck={false}
                    autoFocus
                />
            )}
        </div>
    );
};