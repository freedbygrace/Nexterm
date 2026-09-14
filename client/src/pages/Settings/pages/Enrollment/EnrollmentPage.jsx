import { useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { Permission } from "@/common/utils/permissions.js";
import { deleteRequest, getRequest, postRequest } from "@/common/utils/RequestUtil.js";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import {
    mdiAccount,
    mdiAccountOutline,
    mdiCancel,
    mdiCloudKeyOutline,
    mdiDomain,
    mdiFingerprint,
    mdiKeyRemove,
    mdiKeyStar,
    mdiPlus,
} from "@mdi/js";
import Icon from "@mdi/react";
import Button from "@/common/components/Button";
import SelectBox from "@/common/components/SelectBox";
import { ActionConfirmDialog } from "@/common/components/ActionConfirmDialog/ActionConfirmDialog.jsx";
import EnrollmentDialog from "./components/EnrollmentDialog";
import "./styles.sass";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Why a token can no longer be used, in the order the server checks it (see tokenUnusableReason).
 * "active" means the command still works.
 */
export const tokenState = (token) => {
    if (token.revokedAt) return "revoked";
    if (token.expiresAt && new Date(token.expiresAt) <= new Date()) return "expired";
    if (token.maxUses !== null && token.uses >= token.maxUses) return "usedUp";
    return "active";
};

export const TokenCard = ({ token, scopeLabel, onRevoke, onToggleKey, canManage }) => {
    const { t } = useTranslation();
    const state = tokenState(token);

    const expiry = () => {
        if (!token.expiresAt) return t("settings.enrollment.expiry.never");
        const remaining = new Date(token.expiresAt).getTime() - Date.now();
        if (remaining <= 0) return t("settings.enrollment.expiry.expired");
        const days = Math.floor(remaining / DAY);
        if (days >= 1) return t("settings.enrollment.expiry.inDays", { count: days });
        const hours = Math.max(1, Math.floor(remaining / (60 * 60 * 1000)));
        return t("settings.enrollment.expiry.inHours", { count: hours });
    };

    return (
        <div className="token-card">
            <div className="token-info">
                <Icon path={mdiCloudKeyOutline} className="token-icon" />
                <div className="token-details">
                    <div className="token-heading">
                        <h3>{token.name}</h3>
                        <span className={`token-state state-${state}`}>{t(`settings.enrollment.states.${state}`)}</span>
                    </div>
                    <p className="token-scope">{scopeLabel}</p>

                    <div className="token-facts">
                        <span title={t("settings.enrollment.fields.username")}>
                            <Icon path={mdiAccountOutline} size={0.6} />{token.username}
                        </span>
                        <span title={t("settings.enrollment.fields.uses")}>
                            {token.maxUses === null
                                ? t("settings.enrollment.usesUnlimited", { uses: token.uses })
                                : t("settings.enrollment.usesLimited", { uses: token.uses, maxUses: token.maxUses })}
                        </span>
                        <span title={t("settings.enrollment.fields.expiry")}>{expiry()}</span>
                    </div>

                    {token.fingerprint && (
                        <p className={`token-fingerprint${token.identityDisabled ? " key-disabled" : ""}`}
                           title={t("settings.enrollment.fields.fingerprint")}>
                            <Icon path={token.identityDisabled ? mdiKeyRemove : mdiFingerprint} size={0.6} />
                            {token.fingerprint}
                            {token.identityDisabled && (
                                <span className="key-state">{t("settings.enrollment.keyDisabled")}</span>
                            )}
                        </p>
                    )}
                </div>
            </div>

            {canManage && (
                <div className="token-actions">
                    {/* The key outlives the token, so its state is toggled on its own. */}
                    <button className="action-btn key-btn" onClick={() => onToggleKey(token)}
                            title={t(token.identityDisabled ? "settings.enrollment.enableKey" : "settings.enrollment.disableKey")}>
                        <Icon path={token.identityDisabled ? mdiKeyStar : mdiKeyRemove} size={0.8} />
                    </button>
                    {state !== "revoked" && (
                        <button className="action-btn revoke-btn" onClick={() => onRevoke(token)}
                                title={t("settings.enrollment.revoke")}>
                            <Icon path={mdiCancel} size={0.8} />
                        </button>
                    )}
                </div>
            )}
        </div>
    );
};

export const EnrollmentPage = () => {
    const { t } = useTranslation();
    const { hasPermission } = useContext(UserContext);
    const { sendToast } = useToast();

    const [tokens, setTokens] = useState([]);
    const [organizations, setOrganizations] = useState([]);
    const [selectedScope, setSelectedScope] = useState(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [revokeDialog, setRevokeDialog] = useState({ open: false, token: null });

    const canManage = hasPermission(Permission.IDENTITIES_MANAGE);

    const loadTokens = async (organizationId) => {
        try {
            const result = await getRequest(`enrollment${organizationId ? `?organizationId=${organizationId}` : ""}`);
            setTokens(Array.isArray(result) ? result : []);
        } catch (error) {
            setTokens([]);
            sendToast(t("common.error"), error.message || t("settings.enrollment.loadError"));
        }
    };

    useEffect(() => {
        const fetchOrganizations = async () => {
            try {
                setOrganizations(await getRequest("organizations") || []);
            } catch (error) {
                console.error("Failed to load organizations", error);
            }
        };
        fetchOrganizations();
    }, []);

    useEffect(() => {
        loadTokens(selectedScope);
    }, [selectedScope]);

    const scopeOptions = useMemo(() => [
        { value: null, label: t("settings.enrollment.personal"), icon: mdiAccount },
        ...organizations.map(org => ({ value: org.id, label: org.name, icon: mdiDomain })),
    ], [organizations, t]);

    const scopeLabel = (token) => token.organizationId
        ? organizations.find(org => org.id === token.organizationId)?.name || t("settings.enrollment.organization")
        : t("settings.enrollment.personal");

    const handleDialogClose = () => {
        setDialogOpen(false);
        loadTokens(selectedScope);
    };

    /** Disabling the key is what stops connections to hosts that already enrolled. */
    const toggleKey = async (token) => {
        try {
            await postRequest(`identities/${token.identityId}/disabled`, { disabled: !token.identityDisabled });
            sendToast(t("common.success"),
                t(token.identityDisabled ? "settings.enrollment.keyEnabledSuccess" : "settings.enrollment.keyDisabledSuccess"));
        } catch (error) {
            sendToast(t("common.error"), error.message || t("settings.enrollment.keyStateError"));
        }

        loadTokens(selectedScope);
    };

    const handleRevokeConfirm = async () => {
        const token = revokeDialog.token;
        setRevokeDialog({ open: false, token: null });

        try {
            await deleteRequest(`enrollment/${token.id}`);
            sendToast(t("common.success"), t("settings.enrollment.revokeSuccess"));
        } catch (error) {
            sendToast(t("common.error"), error.message || t("settings.enrollment.revokeError"));
        }

        loadTokens(selectedScope);
    };

    return (
        <div className="enrollment-page">
            <div className="enrollment-section">
                <div className="section-header">
                    <div className="header-content">
                        <h2>{t("settings.enrollment.title")}</h2>
                        <p>{t("settings.enrollment.description")}</p>
                    </div>
                    <div className="header-actions">
                        {scopeOptions.length > 1 && (
                            <SelectBox options={scopeOptions} selected={selectedScope} setSelected={setSelectedScope} />
                        )}
                        {canManage && (
                            <Button text={t("settings.enrollment.createToken")} icon={mdiPlus}
                                    onClick={() => setDialogOpen(true)} />
                        )}
                    </div>
                </div>

                <div className="tokens-grid">
                    {tokens.length > 0 ? tokens.map(token => (
                        <TokenCard key={token.id} token={token} scopeLabel={scopeLabel(token)} canManage={canManage}
                                   onRevoke={(target) => setRevokeDialog({ open: true, token: target })}
                                   onToggleKey={toggleKey} />
                    )) : (
                        <div className="no-tokens">
                            <Icon path={mdiCloudKeyOutline} />
                            <h2>{t("settings.enrollment.noTokens")}</h2>
                            <p>{t("settings.enrollment.noTokensDescription")}</p>
                        </div>
                    )}
                </div>
            </div>

            <EnrollmentDialog open={dialogOpen} onClose={handleDialogClose} organizations={organizations}
                              organizationId={selectedScope} />

            <ActionConfirmDialog open={revokeDialog.open}
                                 setOpen={(open) => setRevokeDialog(prev => ({ ...prev, open }))}
                                 onConfirm={handleRevokeConfirm}
                                 text={t("settings.enrollment.revokeConfirm", { name: revokeDialog.token?.name })} />
        </div>
    );
};
