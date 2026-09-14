import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import Icon from "@mdi/react";
import { mdiAlertCircleOutline, mdiDownload, mdiLoading } from "@mdi/js";
import { SharedRecordingPlayer } from "@/pages/Audit/components/RecordingPlayer/RecordingPlayer.jsx";
import { getBaseUrl } from "@/common/utils/ConnectionUtil.js";
import Button from "@/common/components/Button";
import "./styles.sass";

/**
 * Public playback page for a signed recording share link. No login: the token itself grants access to
 * exactly this one recording, and the server reports its format in X-Recording-Type.
 */
export const SharedRecording = () => {
    const { token } = useParams();
    const { t } = useTranslation();
    const [state, setState] = useState({ loading: true, error: null, recordingType: null });

    useEffect(() => {
        let cancelled = false;

        (async () => {
            try {
                const response = await fetch(`${getBaseUrl()}/api/share/recording/${token}?inline=true`, { method: "HEAD" });
                if (cancelled) return;
                if (!response.ok) {
                    setState({ loading: false, error: response.status === 404 ? "expired" : "failed", recordingType: null });
                    return;
                }
                setState({ loading: false, error: null, recordingType: response.headers.get("x-recording-type") || "guac" });
            } catch {
                if (!cancelled) setState({ loading: false, error: "failed", recordingType: null });
            }
        })();

        return () => { cancelled = true; };
    }, [token]);

    const download = () => {
        const link = document.createElement("a");
        link.href = `${getBaseUrl()}/api/share/recording/${token}`;
        link.download = "";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    return (
        <div className="shared-recording">
            <div className="shared-recording-header">
                <h1>{t("audit.recording.sharedTitle")}</h1>
                {!state.loading && !state.error && (
                    <Button text={t("audit.recording.download")} icon={mdiDownload} type="secondary" onClick={download} />
                )}
            </div>

            {state.loading && (
                <div className="shared-recording-status">
                    <Icon path={mdiLoading} spin />
                </div>
            )}

            {state.error && (
                <div className="shared-recording-status error">
                    <Icon path={mdiAlertCircleOutline} />
                    <p>{t(`audit.recording.errors.${state.error}`)}</p>
                </div>
            )}

            {!state.loading && !state.error && (
                <SharedRecordingPlayer shareToken={token} recordingType={state.recordingType} />
            )}
        </div>
    );
};

export default SharedRecording;
