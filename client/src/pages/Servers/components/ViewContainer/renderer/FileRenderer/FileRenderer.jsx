import { useContext, useEffect, useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { UserContext } from "@/common/contexts/UserContext.jsx";
import { usePreferences } from "@/common/contexts/PreferencesContext.jsx";
import { useToast } from "@/common/contexts/ToastContext.jsx";
import useWebSocket from "react-use-websocket";
import ActionBar from "@/pages/Servers/components/ViewContainer/renderer/FileRenderer/components/ActionBar";
import FileList from "@/pages/Servers/components/ViewContainer/renderer/FileRenderer/components/FileList";
import "./styles.sass";
import Icon from "@mdi/react";
import { mdiCloudUpload, mdiClose } from "@mdi/js";
import { getWebSocketUrl, getBaseUrl } from "@/common/utils/ConnectionUtil.js";
import { uploadFile as uploadFileRequest, tauriDownload } from "@/common/utils/RequestUtil.js";
import { isTauri } from "@/common/utils/TauriUtil.js";

const OPERATIONS = {
    READY: 0x0, LIST_FILES: 0x1, CREATE_FILE: 0x4, CREATE_FOLDER: 0x5, DELETE_FILE: 0x6,
    DELETE_FOLDER: 0x7, RENAME_FILE: 0x8, ERROR: 0x9, SEARCH_DIRECTORIES: 0xA,
    RESOLVE_SYMLINK: 0xB, MOVE_FILES: 0xC, COPY_FILES: 0xD, CHMOD: 0xE,
    STAT: 0xF, CHECKSUM: 0x10, FOLDER_SIZE: 0x11, PATH_SYNC: 0x12,
};

const REFRESH_DEBOUNCE = 150;

const joinPath = (...parts) => parts.join("/").replace(/\/+/g, "/");

const createUploadStats = () => ({ uploaded: 0, failed: 0, cancelled: 0, sentBytes: 0, totalBytes: 0, firstError: null, lastName: "" });

/** Files uploaded at the same time; keeps many small files fast without flooding the SFTP link. */
const UPLOAD_CONCURRENCY = 3;

const readAllEntries = (reader) => new Promise((resolve, reject) => {
    const all = [];
    const next = () => {
        reader.readEntries(batch => {
            if (batch.length) {
                all.push(...batch);
                next();
            } else {
                resolve(all);
            }
        }, reject);
    };
    next();
});

const takeDroppedEntries = (dataTransfer) => [...(dataTransfer.items ?? [])]
    .filter(item => item.kind === "file")
    .map(item => item.webkitGetAsEntry?.())
    .filter(Boolean);

/**
 * Walks dropped files/folders recursively. Files are handed to `onFiles` one directory at a time so
 * uploads start while large trees are still being read; entries the browser refuses to read
 * (permission prompts, broken shortcuts, files removed mid-drag) are counted and skipped instead of
 * aborting the whole drop.
 */
const collectDroppedEntries = async (entries, targetDir, { onFiles, onEmptyDir }) => {
    let skipped = 0;

    const walk = async (entry, dir) => {
        if (entry.isFile) {
            try {
                const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                onFiles([{ file, targetDir: dir }]);
            } catch (err) {
                console.warn("Skipping unreadable dropped file", entry.name, err);
                skipped++;
            }
            return;
        }

        const path = joinPath(dir, entry.name);
        let children;
        try {
            children = await readAllEntries(entry.createReader());
        } catch (err) {
            console.warn("Skipping unreadable dropped folder", entry.name, err);
            skipped++;
            return;
        }
        if (!children.length) {
            onEmptyDir(path);
            return;
        }
        for (const child of children) await walk(child, path);
    };

    for (const entry of entries) await walk(entry, targetDir);
    return { skipped };
};

/** Directories dropped in browsers without the entries API show up as empty, typeless files. */
const isProbablyDirectory = (file) => file.size === 0 && file.type === "" && !file.name.includes(".");

export const FileRenderer = ({ session, disconnectFromServer, setOpenFileEditors, isActive, onOpenTerminal }) => {
    const { t } = useTranslation();
    const { sessionToken } = useContext(UserContext);
    const { defaultViewMode } = usePreferences();
    const { sendToast } = useToast();

    const [dragging, setDragging] = useState(false);
    const [uploadProgress, setUploadProgress] = useState(0);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadRemaining, setUploadRemaining] = useState(0);
    const [directory, setDirectory] = useState("/");
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [history, setHistory] = useState(["/"]);
    const [historyIndex, setHistoryIndex] = useState(0);
    const [viewMode, setViewMode] = useState(defaultViewMode);
    const [directorySuggestions, setDirectorySuggestions] = useState([]);
    const [connectionError, setConnectionError] = useState(null);
    const [isReady, setIsReady] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchResultCount, setSearchResultCount] = useState(0);
    const [capabilities, setCapabilities] = useState({ shell: true, terminal: true });

    const directoryRef = useRef(directory);
    const skipNextPathSync = useRef(false);
    const symlinkCallbacks = useRef([]);
    const dropZoneRef = useRef(null);
    const uploadQueueRef = useRef([]);
    const uploadRunningRef = useRef(false);
    const uploadAbortRef = useRef(null);
    const uploadInFlightRef = useRef(new Map());
    const reconnectAttemptsRef = useRef(0);
    const fileListRef = useRef(null);
    const propertiesHandlerRef = useRef(null);
    const uploadStatsRef = useRef(createUploadStats());
    const refreshTimerRef = useRef(null);

    const wsUrl = getWebSocketUrl("/api/ws/sftp", { sessionToken, sessionId: session.id });

    const downloadFile = async (path) => {
        const baseUrl = getBaseUrl();
        const fileName = path.split("/").pop();
        const url = `${baseUrl}/api/entries/sftp?sessionId=${session.id}&path=${path}&sessionToken=${sessionToken}`;
        
        if (isTauri()) {
            try {
                await tauriDownload(url, fileName);
                sendToast(t("common.success"), t("servers.fileManager.toast.downloaded", { name: fileName }));
            } catch (e) {
                if (e) sendToast(t("common.error"), e.message);
            }
            return;
        }
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const downloadMultipleFiles = async (paths) => {
        if (!paths?.length) return;
        const baseUrl = getBaseUrl();
        const url = `${baseUrl}/api/entries/sftp/multi?sessionId=${session.id}&sessionToken=${sessionToken}`;
        const defaultFileName = paths.length === 1 ? `${paths[0].split("/").pop()}.zip` : "files.zip";
        
        if (isTauri()) {
            try {
                await tauriDownload(url, defaultFileName, {
                    filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
                    fetchOptions: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) }
                });
                sendToast(t("common.success"), t("servers.fileManager.toast.downloadingItems", { count: paths.length }));
            } catch (e) {
                if (e) sendToast(t("common.error"), e.message);
            }
            return;
        }
        const form = document.createElement("form");
        form.method = "POST";
        form.action = url;
        const input = document.createElement("input");
        input.type = "hidden";
        input.name = "paths";
        input.value = JSON.stringify(paths);
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);
        sendToast(t("common.success"), t("servers.fileManager.toast.downloadingItems", { count: paths.length }));
    };

    const refreshUploadProgress = () => {
        const stats = uploadStatsRef.current;
        let inFlight = 0;
        for (const bytes of uploadInFlightRef.current.values()) inFlight += bytes;
        setUploadProgress(stats.totalBytes ? Math.min(100, Math.round(((stats.sentBytes + inFlight) / stats.totalBytes) * 100)) : 0);
        setUploadRemaining(uploadQueueRef.current.length + uploadInFlightRef.current.size);
    };

    const uploadFileHttp = async (file, targetDir, signal) => {
        const filePath = joinPath(targetDir, file.name);
        const stats = uploadStatsRef.current;
        uploadInFlightRef.current.set(file, 0);
        refreshUploadProgress();

        try {
            const url = `/api/entries/sftp/upload?sessionId=${session.id}&path=${encodeURIComponent(filePath)}&sessionToken=${sessionToken}`;
            await uploadFileRequest(url, file, {
                onProgress: (progress) => {
                    uploadInFlightRef.current.set(file, (progress / 100) * file.size);
                    refreshUploadProgress();
                },
                timeout: 5 * 60 * 1000,
                signal,
            });
            stats.uploaded++;
            stats.lastName = file.name;
        } catch (err) {
            if (signal?.aborted || err.message === "Upload cancelled") {
                stats.cancelled++;
            } else {
                console.error("Upload error:", err);
                stats.failed++;
                stats.firstError ??= err.message;
            }
        } finally {
            uploadInFlightRef.current.delete(file);
            stats.sentBytes += file.size;
            refreshUploadProgress();
        }
    };

    const reportUploadResult = ({ uploaded, failed, cancelled, firstError, lastName }) => {
        if (cancelled) {
            sendToast(t("common.error"), t("servers.fileManager.toast.uploadCancelled", { count: uploaded }));
            return;
        }
        if (uploaded) {
            sendToast(t("common.success"), uploaded === 1
                ? t("servers.fileManager.toast.uploaded", { name: lastName })
                : t("servers.fileManager.toast.uploadedItems", { count: uploaded }));
        }
        if (failed) {
            sendToast(t("common.error"), failed === 1
                ? t("servers.fileManager.toast.uploadFailed", { message: firstError })
                : t("servers.fileManager.toast.uploadFailedItems", { count: failed, message: firstError }));
        }
    };

    const processUploadQueue = async () => {
        if (uploadRunningRef.current) return;
        uploadRunningRef.current = true;
        const controller = new AbortController();
        uploadAbortRef.current = controller;
        setIsUploading(true);

        // A small pool of workers drains the queue; each picks the next file when it is done.
        const worker = async () => {
            while (uploadQueueRef.current.length > 0 && !controller.signal.aborted) {
                const { file, targetDir } = uploadQueueRef.current.shift();
                await uploadFileHttp(file, targetDir, controller.signal);
            }
        };
        // Files discovered while the pool was draining (streamed folder walks) must not be stranded.
        do {
            await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
        } while (uploadQueueRef.current.length > 0 && !controller.signal.aborted);

        if (controller.signal.aborted) {
            uploadStatsRef.current.cancelled += uploadQueueRef.current.length;
            uploadQueueRef.current = [];
        }
        uploadRunningRef.current = false;
        uploadAbortRef.current = null;
        setIsUploading(false);
        setUploadProgress(0);
        setUploadRemaining(0);
        listFiles(true);

        const stats = uploadStatsRef.current;
        uploadStatsRef.current = createUploadStats();
        reportUploadResult(stats);
    };

    const cancelUploads = () => {
        uploadQueueRef.current = [];
        uploadAbortRef.current?.abort();
    };

    const queueUploads = (uploads) => {
        if (!uploads.length) return;
        for (const upload of uploads) uploadStatsRef.current.totalBytes += upload.file.size;
        uploadQueueRef.current.push(...uploads);
        refreshUploadProgress();
        processUploadQueue();
    };


    const uploadFile = async () => {
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.onchange = () => {
            queueUploads([...fileInput.files].map(file => ({ file, targetDir: directory })));
        };
        fileInput.click();
    };

    const uploadFolder = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.webkitdirectory = true;
        input.onchange = () => {
            queueUploads([...input.files].map(file => ({
                file,
                targetDir: joinPath(directory, file.webkitRelativePath.split("/").slice(0, -1).join("/")),
            })));
        };
        input.click();
    };

    const processMessage = async (event) => {
        try {
            const data = await event.data.text();
            const operation = data.charCodeAt(0);
            let payload;
            try { payload = JSON.parse(data.slice(1)); } catch {}

            switch (operation) {
                case OPERATIONS.READY:
                    setIsReady(true);
                    setConnectionError(null);
                    setCapabilities(payload?.capabilities ?? { shell: true, terminal: true });
                    reconnectAttemptsRef.current = 0;
                    if (payload?.path && payload.path !== directoryRef.current) {
                        skipNextPathSync.current = true;
                        setDirectory(payload.path);
                        setHistory([payload.path]);
                        setHistoryIndex(0);
                    } else {
                        listFiles();
                    }
                    break;
                case OPERATIONS.LIST_FILES:
                    if (payload?.files) { setItems(payload.files); setError(null); } 
                    else { setError("Failed to load directory contents"); setItems([]); }
                    setLoading(false);
                    break;
                case OPERATIONS.CREATE_FILE:
                case OPERATIONS.CREATE_FOLDER:
                case OPERATIONS.DELETE_FILE:
                case OPERATIONS.DELETE_FOLDER:
                case OPERATIONS.RENAME_FILE:
                case OPERATIONS.MOVE_FILES:
                case OPERATIONS.COPY_FILES:
                case OPERATIONS.CHMOD:
                    scheduleRefresh();
                    break;
                case OPERATIONS.ERROR:
                    sendToast(t("common.error"), payload?.message || t("servers.fileManager.toast.error"));
                    setLoading(false);
                    break;
                case OPERATIONS.SEARCH_DIRECTORIES:
                    if (payload?.directories) setDirectorySuggestions(payload.directories);
                    break;
                case OPERATIONS.RESOLVE_SYMLINK:
                    if (payload) { const cb = symlinkCallbacks.current.shift(); if (cb) cb(payload); }
                    break;
                case OPERATIONS.PATH_SYNC:
                    if (payload?.path && payload.path !== directoryRef.current) {
                        skipNextPathSync.current = true;
                        setDirectory(payload.path);
                        setHistory(prev => [...prev, payload.path]);
                        setHistoryIndex(prev => prev + 1);
                    }
                    break;
                case OPERATIONS.STAT:
                case OPERATIONS.CHECKSUM:
                case OPERATIONS.FOLDER_SIZE:
                    propertiesHandlerRef.current?.({ operation, payload });
                    break;
            }
        } catch (err) { console.error("Error processing SFTP message:", err); }
    };

    const handleWsError = useCallback((event) => {
        console.error("SFTP WebSocket error:", event);
        setConnectionError("Connection error");
        setIsReady(false);
    }, []);

    const handleWsClose = useCallback((event) => {
        setIsReady(false);
        if (event.code === 4001 || event.code === 4002) {
            sendToast(t("common.error"), t("servers.fileManager.toast.connectionLost"));
            disconnectFromServer(session.id);
        }
    }, [disconnectFromServer, session.id]);

    const handleWsOpen = useCallback(() => { reconnectAttemptsRef.current = 0; setConnectionError(null); }, []);

    const { sendMessage, readyState } = useWebSocket(wsUrl, {
        onError: handleWsError,
        onMessage: processMessage,
        onClose: handleWsClose,
        onOpen: handleWsOpen,
        shouldReconnect: (e) => e.code !== 1000 && e.code !== 4001 && e.code !== 4002 && ++reconnectAttemptsRef.current <= 10,
        reconnectAttempts: 10,
        reconnectInterval: 1500,
    });

    const sendOperation = useCallback((operation, payload = {}) => {
        if (readyState !== 1) return false;
        try {
            const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
            const message = new Uint8Array(1 + payloadBytes.length);
            message[0] = operation;
            message.set(payloadBytes, 1);
            sendMessage(message);
            return true;
        } catch { return false; }
    }, [sendMessage, readyState]);

    const createFile = (fileName) => sendOperation(OPERATIONS.CREATE_FILE, { path: `${directory}/${fileName}` });
    const createFolder = (folderName) => sendOperation(OPERATIONS.CREATE_FOLDER, { path: `${directory}/${folderName}` });
    const listFiles = useCallback((silent = false) => { if (!silent) setLoading(true); setError(null); sendOperation(OPERATIONS.LIST_FILES, { path: directory }); }, [directory, sendOperation]);
    const scheduleRefresh = () => {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => listFiles(true), REFRESH_DEBOUNCE);
    };
    const moveFiles = useCallback((sources, destination) => sendOperation(OPERATIONS.MOVE_FILES, { sources, destination }), [sendOperation]);
    const copyFiles = useCallback((sources, destination) => sendOperation(OPERATIONS.COPY_FILES, { sources, destination }), [sendOperation]);

    const changeDirectory = (newDirectory) => {
        if (newDirectory === directory) return;
        setHistory(historyIndex === history.length - 1 ? [...history, newDirectory] : [...history.slice(0, historyIndex + 1), newDirectory]);
        setHistoryIndex(historyIndex + 1);
        setDirectory(newDirectory);
        sendOperation(OPERATIONS.PATH_SYNC, { path: newDirectory });
    };

    const goBack = () => { if (historyIndex > 0) { setHistoryIndex(historyIndex - 1); const p = history[historyIndex - 1]; setDirectory(p); sendOperation(OPERATIONS.PATH_SYNC, { path: p }); } };
    const goForward = () => { if (historyIndex < history.length - 1) { setHistoryIndex(historyIndex + 1); const p = history[historyIndex + 1]; setDirectory(p); sendOperation(OPERATIONS.PATH_SYNC, { path: p }); } };

    const handleFileDrop = async (entries, files, targetDir) => {
        if (!entries.length) {
            const plain = files.filter(file => !isProbablyDirectory(file));
            if (plain.length < files.length) {
                sendToast(t("common.error"), t("servers.fileManager.toast.uploadSkipped", { count: files.length - plain.length }));
            }
            queueUploads(plain.map(file => ({ file, targetDir })));
            return;
        }

        const { skipped } = await collectDroppedEntries(entries, targetDir, {
            onFiles: queueUploads,
            onEmptyDir: (path) => sendOperation(OPERATIONS.CREATE_FOLDER, { path, recursive: true }),
        });
        if (skipped) sendToast(t("common.error"), t("servers.fileManager.toast.uploadSkipped", { count: skipped }));
    };

    /** Uploads the files of a native drop event into `targetDir` (a hovered folder, breadcrumb or the current directory). */
    const uploadDroppedTo = (event, targetDir) => {
        setDragging(false);
        handleFileDrop(takeDroppedEntries(event.dataTransfer), [...event.dataTransfer.files], targetDir).catch(err =>
            sendToast(t("common.error"), t("servers.fileManager.toast.uploadFailed", { message: err.message }))
        );
    };

    const handleDrag = (e) => {
        if (e.dataTransfer.types.includes("application/x-sftp-files")) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragover") setDragging(true);
        else if (e.type === "dragleave" && !dropZoneRef.current.contains(e.relatedTarget)) setDragging(false);
        else if (e.type === "drop") uploadDroppedTo(e, directory);
    };

    const searchDirectories = (searchPath) => sendOperation(OPERATIONS.SEARCH_DIRECTORIES, { searchPath });
    const resolveSymlink = (path, callback) => { symlinkCallbacks.current.push(callback); sendOperation(OPERATIONS.RESOLVE_SYMLINK, { path }); };

    const handleOpenFile = (filePath) => setOpenFileEditors(prev => [...prev, { id: `${session.id}-${filePath}-${Date.now()}`, file: filePath, session, type: 'editor' }]);
    const handleOpenPreview = (filePath) => setOpenFileEditors(prev => [...prev, { id: `${session.id}-${filePath}-${Date.now()}`, file: filePath, session, type: 'preview' }]);

    useEffect(() => { directoryRef.current = directory; }, [directory]);

    useEffect(() => () => clearTimeout(refreshTimerRef.current), []);

    useEffect(() => { setSearchQuery(""); }, [directory]);

    useEffect(() => {
        if (!isActive) return;
        const handler = (e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
                e.preventDefault();
                setSearchOpen(true);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [isActive]);

    const closeSearch = useCallback(() => { setSearchOpen(false); setSearchQuery(""); }, []);

    useEffect(() => {
        if (isReady) {
            if (skipNextPathSync.current) {
                skipNextPathSync.current = false;
            }
            listFiles();
        }
    }, [directory, isReady]);

    return (
        <div className="file-renderer" ref={dropZoneRef} onDragOver={handleDrag} onDragLeave={handleDrag} onDrop={handleDrag}>
            <div className={`drag-overlay ${dragging ? "active" : ""}`}>
                <div className="drag-item">
                    <Icon path={mdiCloudUpload} />
                    <h2>{t("servers.fileManager.dropOverlay")}</h2>
                    <p>{t("servers.fileManager.dropOverlayHint", { directory })}</p>
                </div>
            </div>
            <div className="file-manager">
                <ActionBar path={directory} updatePath={changeDirectory} createFile={() => fileListRef.current?.startCreateFile()}
                    createFolder={() => fileListRef.current?.startCreateFolder()} uploadFile={uploadFile} uploadFolder={uploadFolder}
                    refreshFiles={() => listFiles(true)} goBack={goBack} goForward={goForward} historyIndex={historyIndex}
                    historyLength={history.length} viewMode={viewMode} setViewMode={setViewMode} 
                    searchDirectories={searchDirectories} directorySuggestions={directorySuggestions} 
                    setDirectorySuggestions={setDirectorySuggestions} moveFiles={moveFiles} copyFiles={copyFiles}
                    capabilities={capabilities} onExternalDrop={uploadDroppedTo}
                    sessionId={session.id} searchQuery={searchQuery} setSearchQuery={setSearchQuery} searchOpen={searchOpen}
                    setSearchOpen={setSearchOpen} closeSearch={closeSearch} searchResultCount={searchResultCount} />
                <FileList ref={fileListRef} items={items} path={directory} updatePath={changeDirectory} sendOperation={sendOperation}
                    downloadFile={downloadFile} downloadMultipleFiles={downloadMultipleFiles} setCurrentFile={handleOpenFile} setPreviewFile={handleOpenPreview}
                    loading={loading} viewMode={viewMode} error={error || connectionError} resolveSymlink={resolveSymlink} session={session}
                    createFile={createFile} createFolder={createFolder} moveFiles={moveFiles} copyFiles={copyFiles} isActive={isActive}
                    capabilities={capabilities} onExternalDrop={uploadDroppedTo}
                    searchQuery={searchQuery} onSearchResults={setSearchResultCount}
                    onOpenTerminal={onOpenTerminal} onPropertiesMessage={(handler) => { propertiesHandlerRef.current = handler; }} />
            </div>
            {isUploading && (
                <>
                    <div className="upload-status">
                        <span>{t("servers.fileManager.upload.status", { count: uploadRemaining, percent: uploadProgress })}</span>
                        <button type="button" className="upload-cancel" onClick={cancelUploads}
                                title={t("servers.fileManager.upload.cancel")} aria-label={t("servers.fileManager.upload.cancel")}>
                            <Icon path={mdiClose} />
                        </button>
                    </div>
                    <div className="upload-progress" style={{ width: `${uploadProgress}%` }} />
                </>
            )}
        </div>
    );
};
