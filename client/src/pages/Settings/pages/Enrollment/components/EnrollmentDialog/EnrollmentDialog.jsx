import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "@/common/components/Dialog";
import { postRequest } from "@/common/utils/RequestUtil.js";
import { copyToClipboard } from "@/common/utils/clipboard.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { ServerContext } from "@/common/contexts/ServerContext.jsx";
import {
    mdiAccountOutline,
    mdiAlertOutline,
    mdiCheck,
    mdiCloudKeyOutline,
    mdiContentCopy,
    mdiCounter,
    mdiFingerprint,
    mdiTagOutline,
} from "@mdi/js";
import Icon from "@mdi/react";
import Button from "@/common/components/Button";
import IconInput from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import ToggleSwitch from "@/common/components/ToggleSwitch";
import "./styles.sass";

/** The three use limits the dialog offers; "limited" is the only one that reads the number field. */
const USE_MODES = { SINGLE: "single", LIMITED: "limited", UNLIMITED: "unlimited" };

/**
 * Turns the returned command into the cloud-init form.
 *
 * The command is always `curl -fsSL <url> | sh`, so the url is the one http(s) token in it.
 */
const cloudInitFrom = (command) => {
    const url = command?.match(/https?:\/\/\S+/)?.[0] || "";
    return `#cloud-config\nruncmd:\n  - curl -fsSL ${url} | sh\n`;
};

const CopyField = ({ label, value, hint, onCopy, copied, multiline }) => (
    <div className="copy-field">
        <div className="copy-field-header">
            <label>{label}</label>
            <button type="button" className={`copy-btn ${copied ? "copied" : ""}`} onClick={onCopy}>
                <Icon path={copied ? mdiCheck : mdiContentCopy} size={0.7} />
            </button>
        </div>
        <pre className={`copy-value ${multiline ? "multiline" : ""}`}>{value}</pre>
        {hint && <p className="copy-hint">{hint}</p>}
    </div>
);

export const EnrollmentDialog = ({ open, onClose, organizations = [], organizationId = null }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();
    const { servers, loadServers } = useContext(ServerContext);

    const [name, setName] = useState("");
    const [scope, setScope] = useState(organizationId);
    const [username, setUsername] = useState("root");
    const [createEntries, setCreateEntries] = useState(true);
    const [folderId, setFolderId] = useState(null);
    const [useMode, setUseMode] = useState(USE_MODES.SINGLE);
    const [maxUses, setMaxUses] = useState("5");
    const [lifetime, setLifetime] = useState("7");
    const [isLoading, setIsLoading] = useState(false);
    const [result, setResult] = useState(null);
    const [copied, setCopied] = useState(null);

    useEffect(() => {
        if (!open) return;
        setName("");
        setScope(organizationId);
        setUsername("root");
        setCreateEntries(true);
        setFolderId(null);
        setUseMode(USE_MODES.SINGLE);
        setMaxUses("5");
        setLifetime("7");
        setResult(null);
        setCopied(null);
        // The entry tree normally arrives over the state stream; fetch it when the dialog is the
        // first thing opened after a reload and nothing has populated it yet.
        if (!servers) loadServers?.();
    }, [open, organizationId]);

    /**
     * Flattens the entry tree into folder options for the selected scope.
     *
     * Personal folders sit at the root of the tree; an organization's folders live under its
     * `org-<id>` node (see listFolders on the server).
     */
    const folderOptions = useMemo(() => {
        const options = [{ value: null, label: t("settings.enrollment.dialog.fields.noFolder") }];

        const walk = (nodes, prefix) => {
            (nodes || []).forEach(node => {
                if (node.type !== "folder") return;
                const label = prefix ? `${prefix} / ${node.name}` : node.name;
                options.push({ value: node.id, label });
                walk(node.entries, label);
            });
        };

        if (scope) {
            walk((servers || []).find(node => node.type === "organization" && node.id === `org-${scope}`)?.entries, "");
        } else {
            walk((servers || []).filter(node => node.type === "folder" && !node.organizationId), "");
        }

        return options;
    }, [servers, scope, t]);

    // A folder belongs to one scope, so a scope change invalidates the chosen folder.
    useEffect(() => {
        if (folderId !== null && !folderOptions.some(option => option.value === folderId)) setFolderId(null);
    }, [folderOptions, folderId]);

    const scopeOptions = useMemo(() => [
        { value: null, label: t("settings.enrollment.personal") },
        ...organizations.map(org => ({ value: org.id, label: org.name })),
    ], [organizations, t]);

    const copy = async (key, value) => {
        if (await copyToClipboard(value)) {
            setCopied(key);
            setTimeout(() => setCopied(current => (current === key ? null : current)), 2000);
        } else {
            sendToast(t("common.error"), t("settings.enrollment.dialog.copyFailed"));
        }
    };

    const handleSubmit = async (event) => {
        event.preventDefault();
        setIsLoading(true);

        try {
            const parsedUses = Number.parseInt(maxUses, 10);
            const body = {
                name: name.trim(),
                organizationId: scope || undefined,
                // The folder only ever holds enrolled connections, so it is meaningless without them.
                folderId: (createEntries && folderId) || undefined,
                username: username.trim() || undefined,
                createEntries,
                // null is the server's "no limit"; an absent value would fall back to a single use.
                maxUses: useMode === USE_MODES.UNLIMITED ? null
                    : useMode === USE_MODES.SINGLE ? 1
                        : Number.isFinite(parsedUses) && parsedUses > 0 ? parsedUses : 1,
                lifetimeDays: lifetime === "never" ? null : Number.parseInt(lifetime, 10),
            };

            setResult(await postRequest("enrollment", body));
        } catch (error) {
            sendToast(t("common.error"), error.message || t("settings.enrollment.dialog.createFailed"));
        } finally {
            setIsLoading(false);
        }
    };

    if (result) {
        const cloudInit = cloudInitFrom(result.command);

        return (
            <DialogProvider open={open} onClose={onClose}>
                <div className="enrollment-dialog result">
                    <div className="dialog-title">
                        <Icon path={mdiCloudKeyOutline} />
                        <h2>{t("settings.enrollment.dialog.resultTitle", { name: result.name })}</h2>
                    </div>

                    <div className="dialog-content">
                        <div className="once-warning">
                            <Icon path={mdiAlertOutline} size={0.9} />
                            <p>{t("settings.enrollment.dialog.shownOnce")}</p>
                        </div>

                        <CopyField label={t("settings.enrollment.dialog.command")} value={result.command}
                                   hint={t("settings.enrollment.dialog.commandHint")}
                                   copied={copied === "command"} onCopy={() => copy("command", result.command)} />

                        <CopyField label={t("settings.enrollment.dialog.cloudInit")} value={cloudInit} multiline
                                   hint={t("settings.enrollment.dialog.cloudInitHint")}
                                   copied={copied === "cloudInit"} onCopy={() => copy("cloudInit", cloudInit)} />

                        <div className="result-meta">
                            <span><Icon path={mdiFingerprint} size={0.6} />{result.fingerprint}</span>
                            <span><Icon path={mdiAccountOutline} size={0.6} />{result.username}</span>
                        </div>
                    </div>

                    <div className="dialog-actions">
                        <Button text={t("settings.enrollment.dialog.actions.copyAndClose")} icon={mdiContentCopy}
                                type="secondary" buttonType="button"
                                onClick={async () => {
                                    await copyToClipboard(result.command);
                                    onClose();
                                }} />
                        <Button text={t("settings.enrollment.dialog.actions.done")} buttonType="button"
                                onClick={onClose} />
                    </div>
                </div>
            </DialogProvider>
        );
    }

    return (
        <DialogProvider open={open} onClose={onClose} isDirty={name.trim().length > 0}>
            <div className="enrollment-dialog">
                <div className="dialog-title">
                    <Icon path={mdiCloudKeyOutline} />
                    <h2>{t("settings.enrollment.dialog.createTitle")}</h2>
                </div>

                <form onSubmit={handleSubmit}>
                    <div className="dialog-content">
                        <div className="form-group">
                            <label htmlFor="enrollment-name">{t("settings.enrollment.dialog.fields.name")}</label>
                            <IconInput icon={mdiTagOutline} value={name} setValue={setName} id="enrollment-name"
                                       placeholder={t("settings.enrollment.dialog.fields.namePlaceholder")} required />
                        </div>

                        <div className="form-row">
                            <div className="form-group">
                                <label htmlFor="enrollment-scope">{t("settings.enrollment.dialog.fields.scope")}</label>
                                <SelectBox options={scopeOptions} selected={scope} setSelected={setScope}
                                           id="enrollment-scope" />
                            </div>

                            <div className="form-group">
                                <label htmlFor="enrollment-username">{t("settings.enrollment.dialog.fields.username")}</label>
                                <IconInput icon={mdiAccountOutline} value={username} setValue={setUsername}
                                           id="enrollment-username"
                                           placeholder={t("settings.enrollment.dialog.fields.usernamePlaceholder")} />
                            </div>
                        </div>

                        <div className="form-row">
                            <div className="form-group">
                                <label htmlFor="enrollment-uses">{t("settings.enrollment.dialog.fields.uses")}</label>
                                <SelectBox id="enrollment-uses" selected={useMode} setSelected={setUseMode}
                                           options={[
                                               { label: t("settings.enrollment.dialog.useModes.single"), value: USE_MODES.SINGLE },
                                               { label: t("settings.enrollment.dialog.useModes.limited"), value: USE_MODES.LIMITED },
                                               { label: t("settings.enrollment.dialog.useModes.unlimited"), value: USE_MODES.UNLIMITED },
                                           ]} />
                            </div>

                            <div className="form-group">
                                <label htmlFor="enrollment-lifetime">{t("settings.enrollment.dialog.fields.lifetime")}</label>
                                <SelectBox id="enrollment-lifetime" selected={lifetime} setSelected={setLifetime}
                                           options={[
                                               { label: t("settings.enrollment.dialog.lifetimes.day"), value: "1" },
                                               { label: t("settings.enrollment.dialog.lifetimes.week"), value: "7" },
                                               { label: t("settings.enrollment.dialog.lifetimes.month"), value: "30" },
                                               { label: t("settings.enrollment.dialog.lifetimes.never"), value: "never" },
                                           ]} />
                            </div>
                        </div>

                        {useMode === USE_MODES.LIMITED && (
                            <div className="form-group">
                                <label htmlFor="enrollment-max-uses">{t("settings.enrollment.dialog.fields.maxUses")}</label>
                                <IconInput icon={mdiCounter} type="number" value={maxUses} setValue={setMaxUses}
                                           id="enrollment-max-uses" required />
                            </div>
                        )}

                        <div className="form-toggle">
                            <div className="toggle-text">
                                <label htmlFor="enrollment-create-entries">{t("settings.enrollment.dialog.fields.createEntries")}</label>
                                <p>{t("settings.enrollment.dialog.fields.createEntriesHint")}</p>
                            </div>
                            <ToggleSwitch id="enrollment-create-entries" checked={createEntries}
                                          onChange={setCreateEntries} />
                        </div>

                        {createEntries && (
                            <div className="form-group">
                                <label htmlFor="enrollment-folder">{t("settings.enrollment.dialog.fields.folder")}</label>
                                <SelectBox id="enrollment-folder" options={folderOptions} selected={folderId}
                                           setSelected={setFolderId} searchable={folderOptions.length > 8} />
                            </div>
                        )}
                    </div>

                    <div className="dialog-actions">
                        <Button text={t("common.actions.cancel")} type="secondary" buttonType="button"
                                onClick={onClose} />
                        <Button text={t("settings.enrollment.dialog.actions.create")} buttonType="submit"
                                disabled={isLoading} />
                    </div>
                </form>
            </div>
        </DialogProvider>
    );
};
