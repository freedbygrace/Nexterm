import { DialogProvider } from "@/common/components/Dialog";
import "./styles.sass";
import { useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import { mdiAlertCircleOutline, mdiCheckCircleOutline, mdiFileUploadOutline, mdiMinusCircleOutline } from "@mdi/js";
import Button from "@/common/components/Button";
import Icon from "@mdi/react";
import { postRequest } from "@/common/utils/RequestUtil.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";

const STATUS_ICONS = {
    created: mdiCheckCircleOutline,
    updated: mdiCheckCircleOutline,
    skipped: mdiMinusCircleOutline,
    error: mdiAlertCircleOutline,
};

/** Accepts a full export document (`{ version, entries }`) or a bare array of entries. */
const readDocument = (text) => {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(entries) || entries.length === 0) throw new Error("empty");
    return { entries };
};

const protocolSummary = (entry) => {
    if (Array.isArray(entry?.protocols)) return entry.protocols.join(", ");
    if (entry?.protocols && typeof entry.protocols === "object") {
        return Object.entries(entry.protocols)
            .filter(([, value]) => (typeof value === "object" ? value?.enabled !== false : Boolean(value)))
            .map(([protocol]) => protocol)
            .join(", ");
    }
    return "";
};

export const EntryImportDialog = ({ open, onClose, currentFolderId, currentOrganizationId }) => {
    const { t } = useTranslation();
    const { loadServers } = useContext(ServerContext);
    const { sendToast } = useToast();

    const [content, setContent] = useState("");
    const [results, setResults] = useState(null);
    const [busy, setBusy] = useState(false);

    const document_ = useMemo(() => {
        if (!content.trim()) return { entries: [], error: null };
        try {
            return { ...readDocument(content), error: null };
        } catch (error) {
            return { entries: [], error: error.message === "empty" ? t("servers.entryImport.errors.empty") : t("servers.entryImport.errors.invalidJson") };
        }
    }, [content, t]);

    const resultByIndex = useMemo(() => new Map((results?.results || []).map(row => [row.index, row])), [results]);

    const chooseFile = () => {
        const input = window.document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (event) => { setContent(event.target.result); setResults(null); };
            reader.readAsText(file);
        };
        input.click();
    };

    const send = async (dryRun) => {
        setBusy(true);
        try {
            const response = await postRequest("entries/import/bulk", {
                entries: document_.entries,
                folderId: currentFolderId || undefined,
                organizationId: currentOrganizationId || undefined,
                dryRun,
            });
            setResults(response);
            if (!dryRun) {
                loadServers();
                sendToast(t("common.success"), response.message);
            }
        } catch (error) {
            sendToast(t("common.error"), error.message || t("servers.entryImport.errors.failed"));
        } finally {
            setBusy(false);
        }
    };

    const close = () => { setContent(""); setResults(null); onClose(); };

    return (
        <DialogProvider open={open} onClose={close}>
            <div className="entry-import-dialog">
                <h2>{t("servers.entryImport.title")}</h2>
                <p className="entry-import-hint">{t("servers.entryImport.hint")}</p>

                <div className="form-group">
                    <div className="entry-import-source">
                        <label htmlFor="entry-import-json">{t("servers.entryImport.document")}</label>
                        <Button text={t("servers.entryImport.chooseFile")} icon={mdiFileUploadOutline} type="secondary" onClick={chooseFile} />
                    </div>
                    <textarea id="entry-import-json" spellCheck="false" value={content}
                              placeholder={t("servers.entryImport.placeholder")}
                              onChange={(event) => { setContent(event.target.value); setResults(null); }} />
                    {document_.error && <span className="entry-import-error">{document_.error}</span>}
                </div>

                {document_.entries.length > 0 && (
                    <div className="entry-import-preview">
                        <table>
                            <thead>
                            <tr>
                                <th>{t("servers.entryImport.columns.name")}</th>
                                <th>{t("servers.entryImport.columns.host")}</th>
                                <th>{t("servers.entryImport.columns.protocols")}</th>
                                <th>{t("servers.entryImport.columns.folder")}</th>
                                <th>{t("servers.entryImport.columns.status")}</th>
                            </tr>
                            </thead>
                            <tbody>
                            {document_.entries.map((entry, index) => {
                                const result = resultByIndex.get(index);
                                return (
                                    <tr key={index} className={result ? `row-${result.status}` : ""}>
                                        <td>{entry?.name || "-"}</td>
                                        <td>{entry?.host || "-"}</td>
                                        <td>{protocolSummary(entry) || "-"}</td>
                                        <td>{Array.isArray(entry?.folderPath) ? entry.folderPath.join("/") : entry?.folderPath || "-"}</td>
                                        <td className="status-cell" title={result?.message || ""}>
                                            {result && <Icon path={STATUS_ICONS[result.status]} />}
                                            {result ? t(`servers.entryImport.status.${result.status}`) : ""}
                                        </td>
                                    </tr>
                                );
                            })}
                            </tbody>
                        </table>
                    </div>
                )}

                {results && (
                    <p className="entry-import-summary">
                        {results.dryRun ? t("servers.entryImport.dryRunSummary", { message: results.message }) : results.message}
                    </p>
                )}

                <div className="dialog-actions">
                    <Button text={t("servers.entryImport.actions.check")} type="secondary" onClick={() => send(true)}
                            disabled={busy || document_.entries.length === 0} />
                    <Button text={t("servers.entryImport.actions.import")} onClick={() => send(false)}
                            disabled={busy || document_.entries.length === 0} />
                </div>
            </div>
        </DialogProvider>
    );
};
