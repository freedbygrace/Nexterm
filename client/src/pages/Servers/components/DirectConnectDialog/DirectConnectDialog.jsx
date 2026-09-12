import { DialogProvider } from "@/common/components/Dialog";
import "./styles.sass";
import { useEffect, useState, useCallback, useMemo } from "react";
import Button from "@/common/components/Button";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import { useTranslation } from "react-i18next";
import {
    mdiAccountCircleOutline,
    mdiFileUploadOutline,
    mdiLockOutline,
} from "@mdi/js";
import Input from "@/common/components/IconInput";
import SelectBox from "@/common/components/SelectBox";
import { getFieldConfig } from "@/pages/Servers/components/ServerDialog/utils/fieldConfig.js";
import { getServerProtocols, getPrimaryProtocol, PROTOCOL_LABELS, isCredentiallessProtocol } from "@/common/utils/ProtocolUtil.js";

const readTextFile = (event, setValue) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (fileEvent) => setValue(fileEvent.target.result);
    reader.readAsText(file);
};

/**
 * @param {string|null} initialProtocol - protocol pre-selected by the caller (e.g. "Connect via RDP");
 *                                        when the entry exposes several protocols the user can switch.
 */
export const DirectConnectDialog = ({ open, onClose, onConnect, server, initialProtocol = null }) => {
    const { t } = useTranslation();
    const { sendToast } = useToast();

    const availableProtocols = useMemo(() => getServerProtocols(server), [server]);
    const primaryProtocol = getPrimaryProtocol(server) ?? server?.config?.protocol ?? null;
    const [protocol, setProtocol] = useState(initialProtocol || primaryProtocol);

    const fieldConfig = useMemo(() => getFieldConfig("server", protocol), [protocol]);
    const allowedAuthTypes = fieldConfig.allowedAuthTypes || ["password", "ssh", "both"];
    const defaultAuthType = allowedAuthTypes[0] || "password";

    const [username, setUsername] = useState("");
    const [authType, setAuthType] = useState(defaultAuthType);
    const [password, setPassword] = useState("");
    const [sshKey, setSshKey] = useState(null);
    const [sshCertificate, setSshCertificate] = useState(null);
    const [passphrase, setPassphrase] = useState("");

    const allAuthOptions = [
        { label: t("servers.dialog.identities.passwordOnly"), value: "password-only" },
        { label: t("servers.dialog.identities.userPassword"), value: "password" },
        { label: t("servers.dialog.identities.sshKey"), value: "ssh" },
        { label: t("servers.dialog.identities.both"), value: "both" },
    ];

    const authOptions = useMemo(() =>
        allAuthOptions.filter(opt => allowedAuthTypes.includes(opt.value)),
        [allowedAuthTypes, t]
    );

    const protocolOptions = useMemo(() =>
        availableProtocols.map(p => ({ label: PROTOCOL_LABELS[p] || p.toUpperCase(), value: p })),
        [availableProtocols]
    );

    const readFile = (event) => {
        readTextFile(event, setSshKey);
    };

    const readCertificate = (event) => {
        readTextFile(event, setSshCertificate);
    };

    const credentialless = isCredentiallessProtocol(protocol);

    const validateFields = () => {
        if (credentialless) return true;

        if (authType !== "password-only" && !username) {
            sendToast("Error", t("servers.messages.usernameRequired") || "Username is required");
            return false;
        }

        if ((authType === "password" || authType === "password-only" || authType === "both") && !password) {
            sendToast("Error", t("servers.messages.passwordRequired") || "Password is required");
            return false;
        }

        if ((authType === "ssh" || authType === "both") && !sshKey) {
            sendToast("Error", t("servers.messages.sshKeyRequired") || "SSH key is required");
            return false;
        }

        return true;
    };

    const handleConnect = useCallback(() => {
        if (!validateFields()) return;

        if (credentialless) {
            onConnect(null, protocol);
            onClose();
            return;
        }

        const directIdentity = {
            username: authType === "password-only" ? undefined : username,
            type: authType,
            ...(authType === "password" || authType === "password-only"
                ? { password }
                : authType === "both"
                ? { password, sshKey, passphrase: passphrase || undefined }
                : { sshKey, passphrase: passphrase || undefined }
            ),
        };

        if (authType === "ssh" || authType === "both") directIdentity.sshCertificate = sshCertificate || undefined;

        onConnect(directIdentity, protocol);
        onClose();
    }, [username, authType, password, sshKey, sshCertificate, passphrase, protocol, credentialless, onConnect, onClose]);

    useEffect(() => {
        if (!open) return;

        setProtocol(initialProtocol || primaryProtocol);
        setUsername("");
        setPassword("");
        setSshKey(null);
        setSshCertificate(null);
        setPassphrase("");
    }, [open, initialProtocol, primaryProtocol]);

    useEffect(() => {
        if (!open) return;
        setAuthType(current => allowedAuthTypes.includes(current) ? current : defaultAuthType);
    }, [open, allowedAuthTypes, defaultAuthType]);

    useEffect(() => {
        if (!open) return;

        const submitOnEnter = (event) => {
            if (event.key === "Enter") {
                handleConnect();
            }
        };

        document.addEventListener("keydown", submitOnEnter);

        return () => {
            document.removeEventListener("keydown", submitOnEnter);
        };
    }, [open, handleConnect]);

    const showUsername = authType !== "password-only";
    const showProtocolSelect = protocolOptions.length > 1;

    return (
        <DialogProvider open={open} onClose={onClose}>
            <div className="direct-connect-dialog">
                <div className="direct-connect-header">
                    <h2>{t("servers.contextMenu.quickConnect")}</h2>
                </div>

                <div className="direct-connect-content">
                    {showProtocolSelect && (
                        <div className="form-group">
                            <label>{t("servers.dialog.fields.protocol")}</label>
                            <SelectBox
                                options={protocolOptions}
                                selected={protocol}
                                setSelected={setProtocol}
                            />
                        </div>
                    )}

                    {!credentialless && (
                    <div className="identity-section">
                        <div className={`name-row ${!showUsername ? 'single-column' : ''}`}>
                            {showUsername && (
                                <div className="form-group">
                                    <label htmlFor="username">{t("servers.dialog.fields.username")}</label>
                                    <Input
                                        icon={mdiAccountCircleOutline}
                                        type="text"
                                        placeholder={t("servers.dialog.placeholders.username")}
                                        autoComplete="off"
                                        value={username}
                                        setValue={setUsername}
                                    />
                                </div>
                            )}

                            <div className="form-group">
                                <label>{t("servers.dialog.identities.authentication")}</label>
                                <SelectBox
                                    options={authOptions}
                                    selected={authType}
                                    setSelected={setAuthType}
                                />
                            </div>
                        </div>

                        {(authType === "password" || authType === "password-only" || authType === "both") && (
                            <div className="form-group">
                                <label htmlFor="password">{t("servers.dialog.fields.password")}</label>
                                <Input
                                    icon={mdiLockOutline}
                                    type="password"
                                    placeholder={t("servers.dialog.placeholders.password")}
                                    autoComplete="off"
                                    value={password}
                                    setValue={setPassword}
                                />
                            </div>
                        )}

                        {(authType === "ssh" || authType === "both") && (
                            <>
                                <div className="form-group">
                                    <label htmlFor="keyfile">{t("servers.dialog.identities.sshPrivateKey")}</label>
                                    <Input
                                        icon={mdiFileUploadOutline}
                                        type="file"
                                        autoComplete="off"
                                        onChange={readFile}
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="certificatefile">{t("servers.dialog.identities.sshCertificate")}</label>
                                    <Input
                                        icon={mdiFileUploadOutline}
                                        type="file"
                                        accept=".pub,.crt,.cert,text/plain"
                                        autoComplete="off"
                                        onChange={readCertificate}
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="passphrase">{t("servers.dialog.identities.passphrase")}</label>
                                    <Input
                                        icon={mdiLockOutline}
                                        type="password"
                                        placeholder={t("servers.dialog.identities.passphrase")}
                                        autoComplete="off"
                                        value={passphrase}
                                        setValue={setPassphrase}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                    )}
                </div>

                <Button
                    className="direct-connect-button"
                    onClick={handleConnect}
                    text={t("servers.contextMenu.connect")}
                />
            </div>
        </DialogProvider>
    );
};
