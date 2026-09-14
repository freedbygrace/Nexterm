const { Router } = require("express");
const express = require("express");
const Session = require("../models/Session");
const Account = require("../models/Account");
const SessionManager = require("../lib/SessionManager");
const { getSFTPTransferClient } = require("../lib/ConnectionService");
const Entry = require("../models/Entry");
const { createAuditLog, AUDIT_ACTIONS, RESOURCE_TYPES } = require("../controllers/audit");
const { hasResourcePermission } = require("../utils/permission");
const { Permission } = require("../permissions/registry");
const logger = require("../utils/logger");
const { ZipArchive } = require("archiver");

const app = Router();
const THUMB_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp"]);
const MAX_THUMB_SIZE = 10 * 1024 * 1024;
const MIME_TYPES = {
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4",
    webm: "video/webm", mp3: "audio/mpeg", txt: "text/plain", json: "application/json",
    html: "text/html", css: "text/css", js: "application/javascript",
};

const getExt = (p) => p.split(".").pop()?.toLowerCase();
const getFileName = (p) => p.split("/").pop();
const sanitizeFileName = (name) => name.replaceAll(/[^\w\s.-]/g, "_").substring(0, 255);

const handleError = (res, err) => {
    if (res.headersSent) return;
    const msg = err.message || "Internal error";
    if (msg.includes("does not exist")) return res.status(404).json({ error: "Not found" });
    if (msg.includes("Permission denied")) return res.status(403).json({ error: "Permission denied" });
    res.status(500).json({ error: msg });
};

const checkFilePermission = (ctx, permission) =>
    hasResourcePermission(ctx.user.id, ctx.entry.organizationId, permission);

const audit = (ctx, req, action, resource, details) => {
    createAuditLog({
        accountId: ctx.user.id, organizationId: ctx.entry.organizationId,
        action, resource, details, ipAddress: req.ip, userAgent: req.headers["user-agent"],
    });
};

const archiveFolder = async (sftpClient, archive, dirPath, basePath) => {
    const entries = await sftpClient.listDir(dirPath);
    if (entries.length === 0) {
        archive.append("", { name: basePath + "/" });
        return;
    }
    for (const entry of entries) {
        if (entry.isSymlink) continue;
        const fullPath = dirPath === "/" ? `/${entry.name}` : `${dirPath}/${entry.name}`;
        const archivePath = basePath ? `${basePath}/${entry.name}` : entry.name;
        if (entry.type === "folder") {
            await archiveFolder(sftpClient, archive, fullPath, archivePath);
        } else {
            const { stream, totalSizePromise, done } = sftpClient.readFile(fullPath);
            stream.on("error", (err) => logger.warn("Archive stream error", { error: err.message, path: fullPath }));
            await totalSizePromise;
            archive.append(stream, { name: archivePath });
            await done;
        }
    }
}

const archiveItems = async (sftpClient, archive, paths) => {
    for (const remotePath of paths) {
        try {
            const stats = await sftpClient.stat(remotePath);
            const name = getFileName(remotePath);
            if (stats.isDir) {
                await archiveFolder(sftpClient, archive, remotePath, name);
            } else {
                const { stream, totalSizePromise, done } = sftpClient.readFile(remotePath);
                stream.on("error", (err) => logger.warn("Archive stream error", { error: err.message, path: remotePath }));
                await totalSizePromise;
                archive.append(stream, { name });
                await done;
            }
        } catch (err) {
            logger.warn("Failed to add file to archive", { path: remotePath, error: err.message });
        }
    }
}

const validateSession = async (sessionToken, sessionId) => {
    const session = await Session.findOne({ where: { token: sessionToken } });
    if (!session) return { error: "Invalid session", status: 401 };

    const [user, serverSession] = await Promise.all([
        Account.findByPk(session.accountId),
        Session.update({ lastActivity: new Date() }, { where: { id: session.id } }).then(() => SessionManager.get(sessionId)),
    ]);

    if (!user) return { error: "User not found", status: 401 };
    if (!serverSession) return { error: "Session not found", status: 404 };
    if (serverSession.accountId !== user.id) return { error: "Unauthorized", status: 403 };

    const entry = await Entry.findByPk(serverSession.entryId);
    if (!entry) return { error: "Entry not found", status: 404 };

    const conn = SessionManager.getConnection(sessionId);
    if (!conn?.sftpClient) return { error: "No active SFTP connection", status: 400 };

    let sftpClient = conn.sftpClient;
    try {
        sftpClient = await getSFTPTransferClient(sessionId, entry, user.id);
    } catch (err) {
        logger.warn("Falling back to metadata SFTP client for transfer", { sessionId, error: err.message });
    }

    return { session, user, serverSession, entry, sftpClient };
};

const validateRequest = (query) => {
    const { sessionToken, sessionId, path: remotePath } = query;
    if (!sessionToken || !sessionId || !remotePath) return "Missing parameters";
    if (remotePath.split("/").includes("..")) return "Invalid path";
    return null;
};

/**
 * POST /sftp/upload
 * @summary Upload File via SFTP
 * @description Uploads a file to a remote server via SFTP. The file content should be sent as the raw request body. Missing parent directories are created when the user is allowed to modify files. Requires an active session with SFTP capabilities.
 * @tags SFTP
 * @produces application/json
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote destination path for the uploaded file
 * @return {object} 200 - Upload successful with file path and size
 * @return {object} 400 - Missing parameters or invalid path
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - Permission denied
 * @return {object} 404 - Session or entry not found
 * @return {object} 500 - Upload error
 */
app.post("/upload", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath } = req.query;

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_UPLOAD)))
            return res.status(403).json({ error: "You don't have permission to upload files" });

        const parentPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
        if (parentPath && await checkFilePermission(ctx, Permission.FILES_MODIFY)) {
            const created = await ctx.sftpClient.mkdirRecursive(parentPath);
            for (const folderPath of created)
                audit(ctx, req, AUDIT_ACTIONS.FOLDER_CREATE, RESOURCE_TYPES.FOLDER, { folderPath });
        }

        await ctx.sftpClient.writeFile(remotePath, req);

        const totalSize = Number.parseInt(req.headers["content-length"]) || 0;
        res.json({ success: true, path: remotePath, size: totalSize });
        audit(ctx, req, AUDIT_ACTIONS.FILE_UPLOAD, RESOURCE_TYPES.FILE, { filePath: remotePath, fileSize: totalSize });
    } catch (err) {
        logger.error("Upload error", { error: err.message, path: remotePath });
        handleError(res, err);
    }
});

/** Part file a chunked upload accumulates in before it is renamed to its final name. */
const partPathFor = (remotePath, uploadId) => `${remotePath}.${uploadId}.nexterm-part`;

const validateUploadId = (uploadId) => typeof uploadId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(uploadId);

/** Size of the part file, or 0 when the upload has not started (or was cleaned up). */
const partSize = async (ctx, partPath) => {
    try {
        const stat = await ctx.sftpClient.stat(partPath);
        return Number(stat?.size ?? 0) || 0;
    } catch {
        return 0;
    }
};

/**
 * POST /sftp/upload/chunk
 * @summary Upload One Chunk of a File
 * @description Appends one chunk of a large file to a temporary part file. Chunks must arrive in order: the offset
 * of the chunk has to match the number of bytes already stored, otherwise the request is rejected with the expected
 * offset so the client can continue from there (this is also how an upload resumes after a dropped connection).
 * Send the chunk as the raw request body and finish the upload with POST /sftp/upload/finish.
 * @tags SFTP
 * @produces application/json
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote destination path of the finished file
 * @param {string} uploadId.query.required - Identifier of this upload, chosen by the client
 * @param {number} offset.query.required - Byte offset of this chunk within the file
 * @return {object} 200 - Chunk stored, with the new offset
 * @return {object} 409 - Offset mismatch; the response carries the expected offset
 * @return {object} 403 - Permission denied
 */
app.post("/upload/chunk", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath, uploadId } = req.query;
    const offset = Number.parseInt(req.query.offset, 10);

    if (!validateUploadId(uploadId)) return res.status(400).json({ error: "Invalid upload id" });
    if (!Number.isInteger(offset) || offset < 0) return res.status(400).json({ error: "Invalid offset" });

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_UPLOAD)))
            return res.status(403).json({ error: "You don't have permission to upload files" });

        const partPath = partPathFor(remotePath, uploadId);

        if (offset === 0) {
            const parentPath = remotePath.substring(0, remotePath.lastIndexOf("/"));
            if (parentPath && await checkFilePermission(ctx, Permission.FILES_MODIFY)) {
                const created = await ctx.sftpClient.mkdirRecursive(parentPath);
                for (const folderPath of created)
                    audit(ctx, req, AUDIT_ACTIONS.FOLDER_CREATE, RESOURCE_TYPES.FOLDER, { folderPath });
            }
        } else {
            const received = await partSize(ctx, partPath);
            if (received !== offset) return res.status(409).json({ error: "Offset mismatch", expectedOffset: received });
        }

        await ctx.sftpClient.writeFile(partPath, req, { append: offset > 0 });

        const size = Number.parseInt(req.headers["content-length"], 10) || 0;
        res.json({ success: true, offset: offset + size });
    } catch (err) {
        logger.error("Chunk upload error", { error: err.message, path: remotePath, uploadId });
        handleError(res, err);
    }
});

/**
 * POST /sftp/upload/finish
 * @summary Finish a Chunked Upload
 * @description Renames the part file of a chunked upload to its final name.
 * @tags SFTP
 * @produces application/json
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote destination path
 * @param {string} uploadId.query.required - Identifier of the upload
 * @return {object} 200 - Upload completed
 */
app.post("/upload/finish", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath, uploadId } = req.query;
    if (!validateUploadId(uploadId)) return res.status(400).json({ error: "Invalid upload id" });

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_UPLOAD)))
            return res.status(403).json({ error: "You don't have permission to upload files" });

        const partPath = partPathFor(remotePath, uploadId);
        const size = await partSize(ctx, partPath);

        // The destination is replaced, matching what a plain upload does.
        try { await ctx.sftpClient.unlink(remotePath); } catch { /* no previous file */ }
        await ctx.sftpClient.rename(partPath, remotePath);

        res.json({ success: true, path: remotePath, size });
        audit(ctx, req, AUDIT_ACTIONS.FILE_UPLOAD, RESOURCE_TYPES.FILE, { filePath: remotePath, fileSize: size });
    } catch (err) {
        logger.error("Chunk upload finish error", { error: err.message, path: remotePath, uploadId });
        handleError(res, err);
    }
});

/**
 * GET /sftp/upload/status
 * @summary Progress of a Chunked Upload
 * @description Returns how many bytes of a chunked upload the server already holds, so an interrupted upload can
 * be resumed from that offset instead of starting again.
 * @tags SFTP
 * @produces application/json
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote destination path
 * @param {string} uploadId.query.required - Identifier of the upload
 * @return {object} 200 - Number of bytes received so far
 */
app.get("/upload/status", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath, uploadId } = req.query;
    if (!validateUploadId(uploadId)) return res.status(400).json({ error: "Invalid upload id" });

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        res.json({ offset: await partSize(ctx, partPathFor(remotePath, uploadId)) });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * DELETE /sftp/upload
 * @summary Abort a Chunked Upload
 * @description Removes the part file of an unfinished chunked upload.
 * @tags SFTP
 * @produces application/json
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote destination path
 * @param {string} uploadId.query.required - Identifier of the upload
 * @return {object} 200 - Part file removed
 */
app.delete("/upload", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath, uploadId } = req.query;
    if (!validateUploadId(uploadId)) return res.status(400).json({ error: "Invalid upload id" });

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        try { await ctx.sftpClient.unlink(partPathFor(remotePath, uploadId)); } catch { /* nothing to clean up */ }
        res.json({ success: true });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * GET /sftp
 * @summary Download or Preview File via SFTP
 * @description Downloads a file or folder from a remote server via SFTP. Supports file preview, thumbnail generation for images, and folder download as ZIP archive.
 * @tags SFTP
 * @produces application/octet-stream
 * @produces application/zip
 * @produces image/jpeg
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {string} path.query.required - Remote file or folder path to download
 * @param {string} preview.query - Set to "true" to display file inline instead of downloading
 * @param {string} thumbnail.query - Set to "true" to generate a thumbnail (images only, max 10MB)
 * @param {number} size.query - Thumbnail size in pixels (50-300, default: 100)
 * @return {file} 200 - File content, ZIP archive, or thumbnail image
 * @return {object} 400 - Missing parameters or invalid path
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - Permission denied
 * @return {object} 404 - File, session, or entry not found
 * @return {object} 500 - Download error
 */
app.get("/", async (req, res) => {
    const error = validateRequest(req.query);
    if (error) return res.status(400).json({ error });

    const { sessionToken, sessionId, path: remotePath, preview, thumbnail, size } = req.query;

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_DOWNLOAD)))
            return res.status(403).json({ error: "You don't have permission to download files" });

        const { sftpClient } = ctx;
        const stats = await sftpClient.stat(remotePath);
        const fileName = getFileName(remotePath);
        const safeFileName = sanitizeFileName(fileName);

        if (stats.isDir) {
            res.header("Content-Disposition", `attachment; filename="${safeFileName}.zip"`);
            res.header("Content-Type", "application/zip");
            const archive = new ZipArchive({ zlib: { level: 1 } });
            archive.on("error", (err) => {
                logger.warn("Archive error", { error: err.message, path: remotePath });
                archive.abort();
            });
            res.on("close", () => archive.abort());
            archive.pipe(res);
            await archiveFolder(sftpClient, archive, remotePath, safeFileName);
            archive.finalize();
            audit(ctx, req, AUDIT_ACTIONS.FOLDER_DOWNLOAD, RESOURCE_TYPES.FOLDER, { folderPath: remotePath });
            return;
        }

        if (thumbnail === "true" && THUMB_EXTS.has(getExt(remotePath)) && stats.size <= MAX_THUMB_SIZE) {
            const thumbSize = Math.min(Math.max(Number.parseInt(size) || 100, 50), 300);
            const { data } = await sftpClient.thumbnail(remotePath, thumbSize);
            res.header("Content-Type", "image/jpeg");
            res.header("Cache-Control", "public, max-age=3600");
            res.end(data);
            return;
        }

        const disposition = preview === "true" ? "inline" : "attachment";
        res.header("Content-Disposition", `${disposition}; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
        res.header("Content-Length", stats.size);
        const ext = getExt(remotePath);
        if (MIME_TYPES[ext]) res.header("Content-Type", MIME_TYPES[ext]);

        const { stream } = sftpClient.readFile(remotePath);
        stream.on("error", (err) => { logger.warn("Download stream error", { error: err.message, path: remotePath }); if (!res.headersSent) res.status(500).end(); });
        res.on("close", () => stream.destroy());
        stream.pipe(res);
        audit(ctx, req, AUDIT_ACTIONS.FILE_DOWNLOAD, RESOURCE_TYPES.FILE, { filePath: remotePath, fileSize: stats.size });
    } catch (err) {
        handleError(res, err);
    }
});

/**
 * POST /sftp/multi
 * @summary Download Multiple Files via SFTP
 * @description Downloads multiple files and/or folders as a single ZIP archive. Supports mixed selection of files and folders. Failed items are skipped and logged.
 * @tags SFTP
 * @consumes application/x-www-form-urlencoded
 * @produces application/zip
 * @param {string} sessionToken.query.required - Session authentication token
 * @param {string} sessionId.query.required - Active server session ID
 * @param {object} request.body.required - Request body containing paths array
 * @return {file} 200 - ZIP archive containing all requested files and folders
 * @return {object} 400 - Missing parameters, invalid paths format, or no paths provided
 * @return {object} 401 - Invalid session token
 * @return {object} 403 - Permission denied
 * @return {object} 404 - Session or entry not found
 * @return {object} 500 - Download error
 */
app.post("/multi", express.urlencoded({ extended: true }), async (req, res) => {
    const { sessionToken, sessionId } = req.query;
    let { paths } = req.body;

    if (typeof paths === "string") {
        try { paths = JSON.parse(paths); }
        catch { return res.status(400).json({ error: "Invalid paths format" }); }
    }

    if (!sessionToken || !sessionId) return res.status(400).json({ error: "Missing session parameters" });
    if (!Array.isArray(paths) || paths.length === 0) return res.status(400).json({ error: "No paths provided" });
    if (paths.some((p) => p.includes(".."))) return res.status(400).json({ error: "Invalid path" });

    try {
        const ctx = await validateSession(sessionToken, sessionId);
        if (ctx.error) return res.status(ctx.status).json({ error: ctx.error });

        if (!(await checkFilePermission(ctx, Permission.FILES_DOWNLOAD)))
            return res.status(403).json({ error: "You don't have permission to download files" });

        const timestamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
        res.header("Content-Disposition", `attachment; filename="nexterm-download-${timestamp}.zip"`);
        res.header("Content-Type", "application/zip");

        const archive = new ZipArchive({ zlib: { level: 5 } });
        archive.on("error", (err) => {
            logger.warn("Multi-download archive error", { error: err.message });
            archive.abort();
        });
        res.on("close", () => archive.abort());
        archive.pipe(res);

        await archiveItems(ctx.sftpClient, archive, paths);
        archive.finalize();

        audit(ctx, req, AUDIT_ACTIONS.FILE_DOWNLOAD, RESOURCE_TYPES.FILE, {
            paths,
            count: paths.length,
            connectionReason: ctx.serverSession.connectionReason || null,
        });
    } catch (err) {
        handleError(res, err);
    }
});

module.exports = app;
