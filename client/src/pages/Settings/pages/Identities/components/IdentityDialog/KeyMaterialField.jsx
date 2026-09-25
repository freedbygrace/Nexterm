import { useState } from "react";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiAlertOutline, mdiCheckCircleOutline, mdiClose, mdiFileUploadOutline, mdiTextBoxOutline } from "@mdi/js";

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const CERTIFICATE = /^\s*[a-z0-9-]+-cert-v01@openssh\.com\s+[A-Za-z0-9+/]+=*/;
const PUBLIC_KEY = /^\s*(ssh-(rsa|ed25519|dss)|ecdsa-sha2-[a-z0-9]+|sk-[a-z0-9@.-]+)\s+AAAA/;

/**
 * Why the text does not look like what the field expects, or null. Only a hint: the key is checked
 * for real when the engine uses it.
 */
const problemWith = (kind, text) => {
    if (kind === "certificate") {
        if (CERTIFICATE.test(text)) return null;
        if (PRIVATE_KEY.test(text)) return "certLooksLikeKey";
        return "notACertificate";
    }
    if (PRIVATE_KEY.test(text)) return null;
    if (text.startsWith("PuTTY-User-Key-File")) return "puttyKey";
    if (PUBLIC_KEY.test(text) || CERTIFICATE.test(text)) return "looksLikePublicKey";
    return "notAPrivateKey";
};

/**
 * A private key or certificate, uploaded from a file or pasted as text - both end up as the same
 * string. When editing, leaving it empty keeps what is stored.
 */
export const KeyMaterialField = ({ id, label, kind, value, onChange, editing = false, accept }) => {
    const { t } = useTranslation();
    const [mode, setMode] = useState("file");
    const [fileName, setFileName] = useState(null);

    const readFile = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            setFileName(file.name);
            onChange(String(e.target.result));
        };
        reader.readAsText(file);
    };

    const clear = () => {
        setFileName(null);
        onChange(null);
    };

    const text = value || "";
    const problem = text.trim() ? problemWith(kind, text) : null;
    const prefix = "settings.identities.dialog.keyInput";

    return (
        <div className="form-group key-material">
            <div className="key-material-header">
                <label htmlFor={id}>{label}</label>
                <div className="key-material-modes" role="tablist">
                    <button type="button" role="tab" aria-selected={mode === "file"}
                            className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>
                        <Icon path={mdiFileUploadOutline} />
                        {t(`${prefix}.upload`)}
                    </button>
                    <button type="button" role="tab" aria-selected={mode === "text"}
                            className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>
                        <Icon path={mdiTextBoxOutline} />
                        {t(`${prefix}.paste`)}
                    </button>
                </div>
            </div>

            {mode === "file" ? (
                <label className="key-material-drop" htmlFor={id}>
                    <Icon path={mdiFileUploadOutline} />
                    <span>{fileName || t(`${prefix}.chooseFile`)}</span>
                    <input id={id} type="file" accept={accept} onChange={readFile} />
                </label>
            ) : (
                <textarea id={id} className="key-material-text" value={text} spellCheck={false}
                          autoComplete="off" rows={kind === "certificate" ? 3 : 6}
                          placeholder={t(kind === "certificate" ? `${prefix}.certPlaceholder` : `${prefix}.keyPlaceholder`)}
                          onChange={(e) => { setFileName(null); onChange(e.target.value || null); }} />
            )}

            <div className={`key-material-status${problem ? " warning" : ""}`}>
                {text.trim() ? (
                    <>
                        <Icon path={problem ? mdiAlertOutline : mdiCheckCircleOutline} />
                        <span>{problem ? t(`${prefix}.${problem}`) : t(`${prefix}.loaded`)}</span>
                        <button type="button" className="key-material-clear" onClick={clear} title={t(`${prefix}.clear`)}>
                            <Icon path={mdiClose} />
                        </button>
                    </>
                ) : editing ? (
                    <span>{t(`${prefix}.keepCurrent`)}</span>
                ) : null}
            </div>
        </div>
    );
};

export default KeyMaterialField;
