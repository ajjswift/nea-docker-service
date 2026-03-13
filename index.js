import crypto from "crypto";
import { createServer } from "http";
import { readFile, writeFile, mkdtemp, rm, readdir } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { basename, join } from "path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 3030);
const RUNNER_API_KEY = `${process.env.RUNNER_API_KEY || ""}`.trim();
const RUNNER_IMAGE =
    process.env.RUNNER_IMAGE || "proper-thing/python-runner:gui";
const RUNNER_RUFF_IMAGE =
    process.env.RUNNER_RUFF_IMAGE || "ghcr.io/astral-sh/ruff:latest";
const RUNNER_MEMORY = process.env.RUNNER_MEMORY || "1024m";
const RUNNER_CPUS = process.env.RUNNER_CPUS || "1";
const RUNNER_TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS || 1200000);
const RUNNER_TOOL_TIMEOUT_MS = Number(
    process.env.RUNNER_TOOL_TIMEOUT_MS || 200000,
);
const RUNNER_NETWORK = process.env.RUNNER_NETWORK || "none";
const RUNNER_DISPLAY_NETWORK = process.env.RUNNER_DISPLAY_NETWORK || "bridge";
const MAX_BUFFERED_EVENTS = Number(process.env.MAX_BUFFERED_EVENTS || 250);
const MAX_TOOL_INPUT_BYTES = Number(
    process.env.MAX_TOOL_INPUT_BYTES || 250000
);
const RUNNER_SESSION_RETENTION_MS = Number(
    process.env.RUNNER_SESSION_RETENTION_MS || 30000
);
const RUNNER_DISPLAY_NUMBER = `${process.env.RUNNER_DISPLAY_NUMBER || "99"}`;
const RUNNER_DISPLAY_VNC_PORT = Number(
    process.env.RUNNER_DISPLAY_VNC_PORT || 5900
);
const RUNNER_DISPLAY_NOVNC_PORT = Number(
    process.env.RUNNER_DISPLAY_NOVNC_PORT || 6080
);
const RUNNER_DISPLAY_BIND_HOST =
    process.env.RUNNER_DISPLAY_BIND_HOST || "127.0.0.1";
const RUNNER_DISPLAY_PROXY_HOST =
    process.env.RUNNER_DISPLAY_PROXY_HOST || "127.0.0.1";
const RUNNER_DISPLAY_SCREEN =
    process.env.RUNNER_DISPLAY_SCREEN || "1280x720x24";
const RUNNER_DISPLAY_START_TIMEOUT_MS = Number(
    process.env.RUNNER_DISPLAY_START_TIMEOUT_MS || 15000
);
const DISPLAY_DEBUG = ["1", "true", "yes", "on"].includes(
    `${process.env.DISPLAY_DEBUG || "1"}`.trim().toLowerCase()
);
const RUNNER_LAUNCH_SCRIPT_PATH = new URL(
    "./runtime/start-program.sh",
    import.meta.url
);
const RUNNER_LAUNCH_SCRIPT_NAME = "__runner_start__.sh";

function maskToken(value) {
    const token = `${value || ""}`.trim();
    if (!token) {
        return null;
    }
    if (token.length <= 8) {
        return token;
    }
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function summarizeSession(session) {
    if (!session) {
        return {
            hasSession: false,
        };
    }

    return {
        hasSession: true,
        sessionId: session.id || null,
        containerName: session.containerName || null,
        enableDisplay: Boolean(session.enableDisplay),
        displayHostPort: session.displayHostPort ?? null,
        displayToken: maskToken(session.displayToken),
        processExited:
            session.process?.exitCode !== undefined &&
            session.process?.exitCode !== null,
        stopping: Boolean(session.stopping),
        ended: Boolean(session.ended),
    };
}

function logDisplayDebug(event, details = {}) {
    if (!DISPLAY_DEBUG) {
        return;
    }

    console.log(`[display-runner] ${event}`, {
        pid: process.pid,
        at: new Date().toISOString(),
        ...details,
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, payload) {
    const data = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
    });
    res.end(data);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 1024 * 1024) {
                reject(new Error("Request body too large."));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error("Invalid JSON body."));
            }
        });
        req.on("error", reject);
    });
}

function getBearerToken(req) {
    const value = req.headers.authorization || "";
    const [scheme, token] = value.split(" ");
    if (scheme?.toLowerCase() !== "bearer") return "";
    return `${token || ""}`.trim();
}

function isAuthorized(req) {
    if (!RUNNER_API_KEY) return true;
    return getBearerToken(req) === RUNNER_API_KEY;
}

function normalizeFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
        return [{ name: "main.py", content: "" }];
    }

    const normalized = [];

    for (const file of files) {
        const safeName = basename(
            typeof file?.name === "string" ? file.name.trim() : ""
        );
        if (!safeName) continue;

        normalized.push({
            name: safeName,
            content:
                typeof file?.content === "string"
                    ? file.content
                    : `${file?.content ?? ""}`,
        });
    }

    if (normalized.length === 0) {
        return [{ name: "main.py", content: "" }];
    }

    return normalized;
}

async function readWorkspaceFiles(workspaceDir) {
    if (!workspaceDir) {
        return [];
    }

    const entries = await readdir(workspaceDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile() || entry.name === RUNNER_LAUNCH_SCRIPT_NAME) {
            continue;
        }

        const filePath = join(workspaceDir, entry.name);
        const content = await readFile(filePath, "utf-8");
        files.push({
            name: basename(entry.name),
            content,
        });
    }

    return files;
}

function normalizeBoolean(value) {
    if (typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        return value !== 0;
    }
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        return normalized === "1" || normalized === "true" || normalized === "yes";
    }
    return false;
}

function resolveEntryFile(files, providedEntryFile) {
    const requested = basename(`${providedEntryFile || ""}`.trim());
    if (requested && files.find((file) => file.name === requested)) {
        return requested;
    }
    if (files.find((file) => file.name === "main.py")) {
        return "main.py";
    }
    return files[0]?.name || "main.py";
}

function normalizePythonToolPayload(body = {}) {
    const fileName = basename(
        typeof body?.fileName === "string" ? body.fileName.trim() : ""
    );
    const source =
        typeof body?.source === "string" ? body.source : `${body?.source ?? ""}`;

    if (!fileName) {
        throw new Error("fileName is required.");
    }
    if (!fileName.toLowerCase().endsWith(".py")) {
        throw new Error("Only Python files (.py) are supported.");
    }

    const sourceBytes = Buffer.byteLength(source, "utf8");
    if (
        Number.isFinite(MAX_TOOL_INPUT_BYTES) &&
        MAX_TOOL_INPUT_BYTES > 0 &&
        sourceBytes > MAX_TOOL_INPUT_BYTES
    ) {
        throw new Error("Source is too large.");
    }

    return { fileName, source };
}

function runDockerCommand({
    image,
    args,
    input = "",
    timeoutMs = RUNNER_TOOL_TIMEOUT_MS,
}) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "docker",
            [
                "run",
                "--rm",
                "-i",
                "--network",
                RUNNER_NETWORK,
                "--memory",
                RUNNER_MEMORY,
                "--cpus",
                RUNNER_CPUS,
                image,
                ...args,
            ],
            {
                stdio: ["pipe", "pipe", "pipe"],
            }
        );

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (value, isError = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            if (isError) {
                reject(value);
                return;
            }
            resolve(value);
        };

        const timeoutId = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // Ignore kill errors.
            }
            finish(
                {
                    exitCode: null,
                    stdout,
                    stderr: "Tool execution timed out.",
                    timedOut: true,
                },
                false
            );
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
            stdout += `${chunk}`;
        });
        child.stderr.on("data", (chunk) => {
            stderr += `${chunk}`;
        });
        child.on("error", (error) => {
            finish(error, true);
        });
        child.on("close", (exitCode) => {
            finish({
                exitCode,
                stdout,
                stderr,
                timedOut: false,
            });
        });

        child.stdin.write(input);
        child.stdin.end();
    });
}

function runCommand(command, args, { timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let settled = false;

        const finish = (value, isError = false) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            if (isError) {
                reject(value);
                return;
            }
            resolve(value);
        };

        const timeoutId = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // Ignore kill errors.
            }
            finish(
                new Error(
                    `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`
                ),
                true
            );
        }, timeoutMs);

        child.stdout.on("data", (chunk) => {
            stdout += `${chunk}`;
        });
        child.stderr.on("data", (chunk) => {
            stderr += `${chunk}`;
        });
        child.on("error", (error) => {
            finish(error, true);
        });
        child.on("close", (exitCode) => {
            finish({ exitCode, stdout, stderr });
        });
    });
}

async function resolvePublishedPort(containerName, containerPort) {
    const result = await runCommand("docker", [
        "port",
        containerName,
        `${containerPort}/tcp`,
    ]);

    if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Could not resolve published port.");
    }

    const output = result.stdout.trim().split("\n").find(Boolean) || "";
    const match = output.match(/:(\d+)\s*$/);
    const port = Number(match?.[1]);
    if (!Number.isFinite(port)) {
        throw new Error("Published port could not be parsed.");
    }
    return port;
}

async function waitForDisplayReady(hostPort) {
    const startedAt = Date.now();
    const url = `http://${RUNNER_DISPLAY_PROXY_HOST}:${hostPort}/vnc.html`;
    logDisplayDebug("wait-for-display-ready-start", {
        hostPort,
        url,
        proxyHost: RUNNER_DISPLAY_PROXY_HOST,
    });

    while (Date.now() - startedAt < RUNNER_DISPLAY_START_TIMEOUT_MS) {
        try {
            const response = await fetch(url);
            if (response.ok) {
                logDisplayDebug("wait-for-display-ready-ok", {
                    hostPort,
                    url,
                    status: response.status,
                });
                return;
            }
            logDisplayDebug("wait-for-display-ready-not-ready", {
                hostPort,
                url,
                status: response.status,
            });
        } catch {
            logDisplayDebug("wait-for-display-ready-retry", {
                hostPort,
                url,
            });
        }

        await sleep(200);
    }

    throw new Error("Timed out waiting for the noVNC display to become ready.");
}

function sanitizeProxySearchParams(searchParams, excludedKeys = []) {
    const params = new URLSearchParams();
    for (const [key, value] of searchParams.entries()) {
        if (excludedKeys.includes(key)) {
            continue;
        }
        params.append(key, value);
    }
    const serialized = params.toString();
    return serialized ? `?${serialized}` : "";
}

async function proxyHttpResponse(res, upstreamResponse) {
    const body = Buffer.from(await upstreamResponse.arrayBuffer());
    const headers = {};

    for (const [key, value] of upstreamResponse.headers.entries()) {
        const normalized = key.toLowerCase();
        if (
            normalized === "connection" ||
            normalized === "content-length" ||
            normalized === "date" ||
            normalized === "server" ||
            normalized === "transfer-encoding" ||
            normalized === "keep-alive"
        ) {
            continue;
        }
        headers[normalized] = value;
    }

    headers["content-length"] = String(body.length);
    res.writeHead(upstreamResponse.status, headers);
    res.end(body);
}

function normalizeNewlines(source) {
    return `${source || ""}`.replace(/\r\n/g, "\n");
}

function countLeadingSpaces(line) {
    const leading = line.match(/^(\s*)/)?.[1] || "";
    return leading.replace(/\t/g, "    ").length;
}

function isRecoverableIndentationError(errorText) {
    return /(unexpected indentation|unexpected indent|unindent does not match any outer indentation level)/i.test(
        `${errorText || ""}`
    );
}

function repairCommonIndentation(source) {
    const lines = normalizeNewlines(source).split("\n");
    const repaired = [...lines];

    let previousCodeLine = null;
    let previousIndent = 0;

    for (let index = 0; index < repaired.length; index += 1) {
        const rawLine = repaired[index] || "";
        const normalizedLine = rawLine.replace(/\t/g, "    ");
        const trimmed = normalizedLine.trim();

        if (!trimmed) {
            repaired[index] = "";
            continue;
        }

        const currentIndent = countLeadingSpaces(normalizedLine);
        const previousEndsBlock = previousCodeLine?.trimEnd().endsWith(":");
        let nextIndent = currentIndent;

        if (!previousCodeLine && currentIndent > 0) {
            nextIndent = 0;
        } else if (!previousEndsBlock && currentIndent > previousIndent) {
            nextIndent = previousIndent;
        } else if (previousEndsBlock && currentIndent <= previousIndent) {
            nextIndent = previousIndent + 4;
        }

        if (nextIndent % 4 !== 0) {
            nextIndent = Math.max(0, Math.floor(nextIndent / 4) * 4);
        }

        repaired[index] = `${" ".repeat(nextIndent)}${trimmed}`;
        previousCodeLine = repaired[index];
        previousIndent = nextIndent;
    }

    return repaired.join("\n");
}

async function handlePythonFormatRequest(req, res) {
    if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "Unauthorized." });
        return;
    }

    let body;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        sendJson(res, 400, { error: error.message || "Invalid JSON body." });
        return;
    }

    let payload;
    try {
        payload = normalizePythonToolPayload(body);
    } catch (error) {
        sendJson(res, 400, { error: error.message || "Invalid payload." });
        return;
    }

    try {
        const result = await runDockerCommand({
            image: RUNNER_RUFF_IMAGE,
            args: ["format", "--stdin-filename", payload.fileName, "-"],
            input: payload.source,
        });

        if (result.timedOut) {
            sendJson(res, 504, { error: result.stderr || "Format request timed out." });
            return;
        }

        if (result.exitCode !== 0) {
            const formatError = result.stderr.trim() || "Could not format Python source.";

            if (isRecoverableIndentationError(formatError)) {
                const repairedSource = repairCommonIndentation(payload.source);
                const recovered = await runDockerCommand({
                    image: RUNNER_RUFF_IMAGE,
                    args: ["format", "--stdin-filename", payload.fileName, "-"],
                    input: repairedSource,
                });

                if (!recovered.timedOut && recovered.exitCode === 0) {
                    sendJson(res, 200, {
                        formattedContent: recovered.stdout,
                        repairedIndentation: true,
                    });
                    return;
                }
            }

            sendJson(res, 400, {
                error: formatError,
            });
            return;
        }

        sendJson(res, 200, {
            formattedContent: result.stdout,
        });
    } catch (error) {
        console.error("Python format request failed:", error);
        sendJson(res, 500, {
            error: "Failed to run Python formatter.",
        });
    }
}

async function handlePythonLintRequest(req, res) {
    if (!isAuthorized(req)) {
        sendJson(res, 401, { error: "Unauthorized." });
        return;
    }

    let body;
    try {
        body = await readJsonBody(req);
    } catch (error) {
        sendJson(res, 400, { error: error.message || "Invalid JSON body." });
        return;
    }

    let payload;
    try {
        payload = normalizePythonToolPayload(body);
    } catch (error) {
        sendJson(res, 400, { error: error.message || "Invalid payload." });
        return;
    }

    try {
        const result = await runDockerCommand({
            image: RUNNER_RUFF_IMAGE,
            args: [
                "check",
                "--stdin-filename",
                payload.fileName,
                "--output-format",
                "json",
                "-",
            ],
            input: payload.source,
        });

        if (result.timedOut) {
            sendJson(res, 504, { error: result.stderr || "Lint request timed out." });
            return;
        }

        if (result.exitCode !== 0 && result.exitCode !== 1) {
            sendJson(res, 400, {
                error: result.stderr.trim() || "Could not lint Python source.",
            });
            return;
        }

        let diagnostics = [];
        try {
            const parsed = JSON.parse(result.stdout || "[]");
            diagnostics = Array.isArray(parsed) ? parsed : [];
        } catch {
            sendJson(res, 500, {
                error: "Lint output could not be parsed.",
            });
            return;
        }

        sendJson(res, 200, {
            diagnostics,
            hasIssues: diagnostics.length > 0,
        });
    } catch (error) {
        console.error("Python lint request failed:", error);
        sendJson(res, 500, {
            error: "Failed to run Python linter.",
        });
    }
}

class ExecutionSession {
    constructor(files, entryFile, enableDisplay, onDispose) {
        const normalizedEnableDisplay = normalizeBoolean(enableDisplay);
        this.id = crypto.randomUUID();
        this.streamToken = crypto.randomUUID();
        this.displayToken = normalizedEnableDisplay ? crypto.randomUUID() : null;
        this.files = normalizeFiles(files);
        this.entryFile = resolveEntryFile(this.files, entryFile);
        this.enableDisplay = normalizedEnableDisplay;
        this.onDispose = onDispose;

        this.tempDir = null;
        this.containerName = `python-run-${crypto.randomUUID()}`;
        this.process = null;
        this.timeoutId = null;
        this.cleaned = false;
        this.stopping = false;
        this.ended = false;
        this.displayHostPort = null;
        this.displayScriptPath = null;
        this.finalFiles = this.files.map((file) => ({ ...file }));

        this.subscribers = new Set();
        this.bufferedEvents = [];
    }

    async start() {
        this.tempDir = await mkdtemp(join(tmpdir(), "runner-"));
        for (const file of this.files) {
            await writeFile(join(this.tempDir, file.name), file.content, "utf-8");
        }

        this.displayScriptPath = join(this.tempDir, RUNNER_LAUNCH_SCRIPT_NAME);
        const launchScript = await readFile(RUNNER_LAUNCH_SCRIPT_PATH, "utf-8");
        await writeFile(this.displayScriptPath, launchScript, "utf-8");

        const dockerArgs = [
            "run",
            "--rm",
            "-i",
            "--name",
            this.containerName,
            "--network",
            this.enableDisplay ? RUNNER_DISPLAY_NETWORK : RUNNER_NETWORK,
            "--memory",
            RUNNER_MEMORY,
            "--cpus",
            RUNNER_CPUS,
            "-v",
            `${this.tempDir}:/workspace`,
            "-w",
            "/workspace",
            "-e",
            `ENTRY_FILE=${this.entryFile}`,
            "-e",
            `ENABLE_DISPLAY=${this.enableDisplay ? "1" : "0"}`,
            "-e",
            `DISPLAY_NUMBER=${RUNNER_DISPLAY_NUMBER}`,
            "-e",
            `DISPLAY_SCREEN=${RUNNER_DISPLAY_SCREEN}`,
            "-e",
            `VNC_PORT=${RUNNER_DISPLAY_VNC_PORT}`,
            "-e",
            `NOVNC_PORT=${RUNNER_DISPLAY_NOVNC_PORT}`,
        ];

        if (this.enableDisplay) {
            dockerArgs.push(
                "-p",
                `${RUNNER_DISPLAY_BIND_HOST}::${RUNNER_DISPLAY_NOVNC_PORT}`
            );
        }

        dockerArgs.push(
            RUNNER_IMAGE,
            "/bin/sh",
            `/workspace/${RUNNER_LAUNCH_SCRIPT_NAME}`
        );

        logDisplayDebug("session-start", {
            ...summarizeSession(this),
            entryFile: this.entryFile,
            fileCount: this.files.length,
            tempDir: this.tempDir,
            displayBindHost: RUNNER_DISPLAY_BIND_HOST,
            displayProxyHost: RUNNER_DISPLAY_PROXY_HOST,
            dockerArgs,
        });

        this.process = spawn("docker", dockerArgs, {
            stdio: ["pipe", "pipe", "pipe"],
        });

        this.timeoutId = setTimeout(async () => {
            this.emit({
                type: "programError",
                data: `Execution timed out after ${RUNNER_TIMEOUT_MS}ms`,
            });
            await this.stop();
        }, RUNNER_TIMEOUT_MS);

        this.process.stdout.on("data", (data) => {
            this.emit({ type: "programOutput", data: `${data}` });
        });

        this.process.stderr.on("data", (data) => {
            this.emit({ type: "programOutput", data: `${data}` });
        });

        this.process.on("error", (error) => {
            logDisplayDebug("session-process-error", {
                ...summarizeSession(this),
                error: error?.message || "Docker process error.",
            });
            this.emit({
                type: "programError",
                data: error?.message || "Docker process error.",
            });
        });

        this.process.on("close", async (exitCode) => {
            logDisplayDebug("session-process-close", {
                ...summarizeSession(this),
                exitCode,
            });
            await this.captureWorkspaceFiles();
            if (this.enableDisplay) {
                this.emit({
                    type: "displayState",
                    data: {
                        enabled: false,
                        status: "closed",
                    },
                });
            }
            this.emit({ type: "programExit", data: { exitCode } });
            await this.cleanup();
        });

        if (this.enableDisplay) {
            this.emit({
                type: "displayState",
                data: {
                    enabled: true,
                    status: "starting",
                },
            });

            try {
                this.displayHostPort = await this.waitForDisplayPort();
                logDisplayDebug("display-port-resolved", {
                    ...summarizeSession(this),
                });
                await waitForDisplayReady(this.displayHostPort);
                logDisplayDebug("display-ready", {
                    ...summarizeSession(this),
                });
                this.emit({
                    type: "displayState",
                    data: {
                        enabled: true,
                        status: "ready",
                    },
                });
            } catch (error) {
                logDisplayDebug("display-start-failed", {
                    ...summarizeSession(this),
                    error:
                        error?.message ||
                        "The graphical display did not become ready.",
                });
                this.emit({
                    type: "displayState",
                    data: {
                        enabled: false,
                        status: "error",
                        reason:
                            error?.message ||
                            "The graphical display did not become ready.",
                    },
                });
                await this.stop();
                throw error;
            }
        }
    }

    async captureWorkspaceFiles() {
        if (!this.tempDir) {
            return this.finalFiles.map((file) => ({ ...file }));
        }

        try {
            this.finalFiles = await readWorkspaceFiles(this.tempDir);
        } catch (error) {
            console.error("Failed to capture workspace files:", error);
        }

        return this.finalFiles.map((file) => ({ ...file }));
    }

    async getWorkspaceFiles() {
        if (this.tempDir) {
            return this.captureWorkspaceFiles();
        }

        return this.finalFiles.map((file) => ({ ...file }));
    }

    async waitForDisplayPort() {
        const startedAt = Date.now();
        logDisplayDebug("wait-for-display-port-start", {
            ...summarizeSession(this),
            expectedContainerPort: RUNNER_DISPLAY_NOVNC_PORT,
        });

        while (Date.now() - startedAt < RUNNER_DISPLAY_START_TIMEOUT_MS) {
            if (!this.process || this.process.exitCode !== null) {
                logDisplayDebug("wait-for-display-port-process-exited", {
                    ...summarizeSession(this),
                    exitCode: this.process?.exitCode ?? null,
                });
                throw new Error("The graphical container exited before the display was ready.");
            }

            try {
                const port = await resolvePublishedPort(
                    this.containerName,
                    RUNNER_DISPLAY_NOVNC_PORT
                );
                logDisplayDebug("wait-for-display-port-ok", {
                    ...summarizeSession(this),
                    resolvedPort: port,
                });
                return port;
            } catch {
                logDisplayDebug("wait-for-display-port-retry", {
                    ...summarizeSession(this),
                    expectedContainerPort: RUNNER_DISPLAY_NOVNC_PORT,
                });
                await sleep(200);
            }
        }

        throw new Error("Timed out waiting for the published noVNC port.");
    }

    emit(event) {
        const payload = JSON.stringify(event);
        if (this.subscribers.size === 0) {
            this.bufferedEvents.push(payload);
            if (this.bufferedEvents.length > MAX_BUFFERED_EVENTS) {
                this.bufferedEvents.shift();
            }
            return;
        }

        for (const ws of this.subscribers) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            }
        }
    }

    attachSubscriber(ws) {
        this.subscribers.add(ws);

        if (this.bufferedEvents.length > 0) {
            for (const payload of this.bufferedEvents) {
                if (ws.readyState !== WebSocket.OPEN) break;
                ws.send(payload);
            }
            this.bufferedEvents = [];
        }

        if (this.ended && ws.readyState === WebSocket.OPEN) {
            // Keep event ordering: close frame is sent after buffered events.
            setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1000, "Session completed");
                }
            }, 0);
        }
    }

    detachSubscriber(ws) {
        this.subscribers.delete(ws);
    }

    async sendInput(input) {
        if (!this.process || !this.process.stdin) {
            throw new Error("Session is not running.");
        }
        this.process.stdin.write(`${input ?? ""}`);
    }

    hasDisplay() {
        return this.enableDisplay && Number.isFinite(this.displayHostPort);
    }

    validateDisplayToken(token) {
        return Boolean(
            this.displayToken &&
                `${token || ""}`.trim() &&
                `${token}` === this.displayToken
        );
    }

    async stop() {
        if (this.stopping) return;
        this.stopping = true;
        logDisplayDebug("session-stop", {
            ...summarizeSession(this),
        });

        try {
            if (this.containerName) {
                spawn("docker", ["kill", this.containerName], {
                    stdio: ["ignore", "ignore", "ignore"],
                });
            }

            if (this.process && !this.process.killed) {
                this.process.kill();
            } else if (!this.process) {
                await this.cleanup();
            }
        } finally {
            this.stopping = false;
        }
    }

    async cleanup() {
        if (this.cleaned) return;
        this.cleaned = true;
        this.ended = true;
        logDisplayDebug("session-cleanup", {
            ...summarizeSession(this),
            tempDir: this.tempDir,
        });

        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        this.process = null;
        this.containerName = null;
        this.displayHostPort = null;
        this.displayScriptPath = null;

        if (this.tempDir) {
            try {
                await this.captureWorkspaceFiles();
                await rm(this.tempDir, { recursive: true, force: true });
            } catch (error) {
                console.error("Cleanup error:", error);
            }
            this.tempDir = null;
        }

        this.onDispose(this.id);
    }
}

class SessionStore {
    constructor() {
        this.sessions = new Map();
        this.cleanupTimers = new Map();
    }

    get(id) {
        const session = this.sessions.get(id) || null;
        logDisplayDebug("session-get", {
            sessionId: id,
            ...summarizeSession(session),
            sessionCount: this.sessions.size,
        });
        return session;
    }

    async create(files, entryFile, enableDisplay) {
        const session = new ExecutionSession(files, entryFile, enableDisplay, (id) => {
            this.markForCleanup(id);
        });

        this.sessions.set(session.id, session);
        logDisplayDebug("session-create", {
            ...summarizeSession(session),
            entryFile,
            enableDisplay,
            sessionCount: this.sessions.size,
        });
        try {
            await session.start();
            logDisplayDebug("session-create-ready", {
                ...summarizeSession(session),
                sessionCount: this.sessions.size,
            });
            return session;
        } catch (error) {
            logDisplayDebug("session-create-failed", {
                ...summarizeSession(session),
                error: error?.message || "Session start failed.",
                sessionCount: this.sessions.size,
            });
            this.deleteNow(session.id);
            await session.stop().catch(() => {});
            await session.cleanup();
            throw error;
        }
    }

    markForCleanup(id) {
        if (!this.sessions.has(id)) return;
        if (this.cleanupTimers.has(id)) return;
        logDisplayDebug("session-mark-for-cleanup", {
            sessionId: id,
            retentionMs: RUNNER_SESSION_RETENTION_MS,
            sessionCount: this.sessions.size,
        });

        if (!Number.isFinite(RUNNER_SESSION_RETENTION_MS) || RUNNER_SESSION_RETENTION_MS <= 0) {
            this.deleteNow(id);
            return;
        }

        const timer = setTimeout(() => {
            this.deleteNow(id);
        }, RUNNER_SESSION_RETENTION_MS);

        this.cleanupTimers.set(id, timer);
    }

    deleteNow(id) {
        const existingTimer = this.cleanupTimers.get(id);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.cleanupTimers.delete(id);
        }
        logDisplayDebug("session-delete", {
            sessionId: id,
            hadSession: this.sessions.has(id),
            sessionCountBeforeDelete: this.sessions.size,
        });
        this.sessions.delete(id);
    }
}

const sessions = new SessionStore();

function parseSessionRoute(pathname) {
    const match = pathname.match(/^\/v1\/sessions\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    return {
        sessionId: decodeURIComponent(match[1]),
        action: match[2],
    };
}

function parseDisplayAssetRoute(pathname) {
    const match = pathname.match(
        /^\/v1\/sessions\/([^/]+)\/display\/novnc\/(.+)$/
    );
    if (!match) return null;
    return {
        sessionId: decodeURIComponent(match[1]),
        assetPath: match[2],
    };
}

function parseDisplaySocketRoute(pathname) {
    const match = pathname.match(
        /^\/v1\/sessions\/([^/]+)\/display\/websockify$/
    );
    if (!match) return null;
    return {
        sessionId: decodeURIComponent(match[1]),
    };
}

const httpServer = createServer(async (req, res) => {
    try {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

        if (req.method === "GET" && url.pathname === "/health") {
            sendJson(res, 200, { ok: true });
            return;
        }

        if (req.method === "POST" && url.pathname === "/v1/sessions") {
            if (!isAuthorized(req)) {
                sendJson(res, 401, { error: "Unauthorized." });
                return;
            }

            let body;
            try {
                body = await readJsonBody(req);
            } catch (error) {
                sendJson(res, 400, { error: error.message || "Invalid JSON body." });
                return;
            }

            try {
                const session = await sessions.create(
                    body?.files,
                    body?.entryFile,
                    body?.enableDisplay
                );
                sendJson(res, 200, {
                    sessionId: session.id,
                    streamToken: session.streamToken,
                    displayToken: session.displayToken,
                });
            } catch (error) {
                console.error("Failed to create session:", error);
                sendJson(res, 500, {
                    error: error?.message || "Failed to create execution session.",
                });
            }
            return;
        }

        const displayAssetRoute = parseDisplayAssetRoute(url.pathname);
        if (displayAssetRoute && req.method === "GET") {
            const session = sessions.get(displayAssetRoute.sessionId);
            const displayToken = `${url.searchParams.get("displayToken") || ""}`;
            logDisplayDebug("asset-request", {
                sessionId: displayAssetRoute.sessionId,
                assetPath: displayAssetRoute.assetPath,
                displayToken: maskToken(displayToken),
                ...summarizeSession(session),
            });
            if (!session || !session.hasDisplay()) {
                logDisplayDebug("asset-request-miss", {
                    sessionId: displayAssetRoute.sessionId,
                    assetPath: displayAssetRoute.assetPath,
                    displayToken: maskToken(displayToken),
                    ...summarizeSession(session),
                });
                sendJson(res, 404, { error: "Display session not found." });
                return;
            }

            if (!session.validateDisplayToken(displayToken)) {
                logDisplayDebug("asset-request-unauthorized", {
                    sessionId: displayAssetRoute.sessionId,
                    assetPath: displayAssetRoute.assetPath,
                    displayToken: maskToken(displayToken),
                    ...summarizeSession(session),
                });
                sendJson(res, 401, { error: "Unauthorized." });
                return;
            }

            try {
                const upstreamPath = `/${displayAssetRoute.assetPath}${sanitizeProxySearchParams(
                    url.searchParams,
                    ["displayToken"]
                )}`;
                const upstreamUrl = `http://${RUNNER_DISPLAY_PROXY_HOST}:${session.displayHostPort}${upstreamPath}`;
                logDisplayDebug("asset-upstream-fetch", {
                    sessionId: displayAssetRoute.sessionId,
                    assetPath: displayAssetRoute.assetPath,
                    upstreamUrl,
                    ...summarizeSession(session),
                });
                const upstream = await fetch(
                    upstreamUrl
                );
                logDisplayDebug("asset-upstream-response", {
                    sessionId: displayAssetRoute.sessionId,
                    assetPath: displayAssetRoute.assetPath,
                    upstreamUrl,
                    upstreamStatus: upstream.status,
                    ...summarizeSession(session),
                });
                await proxyHttpResponse(res, upstream);
            } catch (error) {
                logDisplayDebug("asset-upstream-error", {
                    sessionId: displayAssetRoute.sessionId,
                    assetPath: displayAssetRoute.assetPath,
                    displayToken: maskToken(displayToken),
                    error:
                        error?.message ||
                        "Could not proxy the noVNC asset request.",
                    ...summarizeSession(session),
                });
                sendJson(res, 502, {
                    error:
                        error?.message ||
                        "Could not proxy the noVNC asset request.",
                });
            }
            return;
        }

        if (req.method === "POST" && url.pathname === "/v1/python/format") {
            await handlePythonFormatRequest(req, res);
            return;
        }

        if (req.method === "POST" && url.pathname === "/v1/python/lint") {
            await handlePythonLintRequest(req, res);
            return;
        }

        const route = parseSessionRoute(url.pathname);
        if (!route) {
            sendJson(res, 404, { error: "Not found." });
            return;
        }

        const session = sessions.get(route.sessionId);
        if (!session) {
            sendJson(res, 404, { error: "Session not found." });
            return;
        }

        if (route.action === "stream" && req.method === "GET") {
            // This route is for websocket upgrade only.
            sendJson(res, 426, { error: "Upgrade Required." });
            return;
        }

        if (!isAuthorized(req)) {
            sendJson(res, 401, { error: "Unauthorized." });
            return;
        }

        if (route.action === "stdin" && req.method === "POST") {
            let body;
            try {
                body = await readJsonBody(req);
            } catch (error) {
                sendJson(res, 400, { error: error.message || "Invalid JSON body." });
                return;
            }

            try {
                await session.sendInput(body?.input ?? "");
                sendJson(res, 200, { ok: true });
            } catch (error) {
                sendJson(res, 400, {
                    error: error?.message || "Failed to send input.",
                });
            }
            return;
        }

        if (route.action === "stop" && req.method === "POST") {
            try {
                await session.stop();
                sendJson(res, 200, { ok: true });
            } catch (error) {
                sendJson(res, 500, {
                    error: error?.message || "Failed to stop session.",
                });
            }
            return;
        }

        if (route.action === "files" && req.method === "GET") {
            try {
                const files = await session.getWorkspaceFiles();
                sendJson(res, 200, { files });
            } catch (error) {
                sendJson(res, 500, {
                    error: error?.message || "Failed to read session files.",
                });
            }
            return;
        }

        sendJson(res, 404, { error: "Not found." });
    } catch (error) {
        console.error("Unhandled request error:", error);
        if (!res.headersSent) {
            sendJson(res, 500, { error: "Internal server error." });
        } else {
            res.end();
        }
    }
});

const wsServer = new WebSocketServer({ noServer: true });
const displayWsServer = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
    try {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const route = parseSessionRoute(url.pathname);
        const displayRoute = parseDisplaySocketRoute(url.pathname);

        if (displayRoute) {
            const session = sessions.get(displayRoute.sessionId);
            const displayToken = `${url.searchParams.get("displayToken") || ""}`;
            logDisplayDebug("display-socket-upgrade-request", {
                sessionId: displayRoute.sessionId,
                displayToken: maskToken(displayToken),
                ...summarizeSession(session),
            });
            if (!session || !session.hasDisplay()) {
                logDisplayDebug("display-socket-upgrade-miss", {
                    sessionId: displayRoute.sessionId,
                    displayToken: maskToken(displayToken),
                    ...summarizeSession(session),
                });
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!session.validateDisplayToken(displayToken)) {
                logDisplayDebug("display-socket-upgrade-unauthorized", {
                    sessionId: displayRoute.sessionId,
                    displayToken: maskToken(displayToken),
                    ...summarizeSession(session),
                });
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }

            displayWsServer.handleUpgrade(req, socket, head, (ws) => {
                logDisplayDebug("display-socket-upgrade-ok", {
                    sessionId: displayRoute.sessionId,
                    displayToken: maskToken(displayToken),
                    ...summarizeSession(session),
                });
                displayWsServer.emit("connection", ws, displayRoute.sessionId);
            });
            return;
        }

        if (!route || route.action !== "stream") {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        const session = sessions.get(route.sessionId);
        if (!session) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
        }

        const streamToken = `${url.searchParams.get("streamToken") || ""}`;
        if (!streamToken || streamToken !== session.streamToken) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
        }

        wsServer.handleUpgrade(req, socket, head, (ws) => {
            wsServer.emit("connection", ws, route.sessionId);
        });
    } catch {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
        socket.destroy();
    }
});

wsServer.on("connection", (ws, sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) {
        ws.close();
        return;
    }

    session.attachSubscriber(ws);
    ws.on("close", () => {
        const existing = sessions.get(sessionId);
        if (!existing) return;
        existing.detachSubscriber(ws);
    });
});

displayWsServer.on("connection", (downstream, sessionId) => {
    const session = sessions.get(sessionId);
    if (!session || !session.hasDisplay()) {
        logDisplayDebug("display-proxy-open-miss", {
            sessionId,
            ...summarizeSession(session),
        });
        downstream.close();
        return;
    }

    const upstreamUrl = `ws://${RUNNER_DISPLAY_PROXY_HOST}:${session.displayHostPort}/websockify`;
    logDisplayDebug("display-proxy-open", {
        sessionId,
        upstreamUrl,
        ...summarizeSession(session),
    });
    const upstream = new WebSocket(
        upstreamUrl
    );
    upstream.binaryType = "arraybuffer";

    const closeBoth = () => {
        if (downstream.readyState === WebSocket.OPEN) {
            downstream.close();
        }
        if (
            upstream.readyState === WebSocket.OPEN ||
            upstream.readyState === WebSocket.CONNECTING
        ) {
            upstream.close();
        }
    };

    downstream.on("message", (data, isBinary) => {
        if (upstream.readyState !== WebSocket.OPEN) {
            return;
        }
        upstream.send(data, { binary: isBinary });
    });

    downstream.on("close", () => {
        logDisplayDebug("display-proxy-downstream-close", {
            sessionId,
            ...summarizeSession(session),
        });
        closeBoth();
    });

    downstream.on("error", () => {
        logDisplayDebug("display-proxy-downstream-error", {
            sessionId,
            ...summarizeSession(session),
        });
        closeBoth();
    });

    upstream.on("message", (data, isBinary) => {
        if (downstream.readyState !== WebSocket.OPEN) {
            return;
        }
        downstream.send(data, { binary: isBinary });
    });

    upstream.on("open", () => {
        logDisplayDebug("display-proxy-upstream-open", {
            sessionId,
            upstreamUrl,
            ...summarizeSession(session),
        });
    });

    upstream.on("close", (event) => {
        logDisplayDebug("display-proxy-upstream-close", {
            sessionId,
            upstreamUrl,
            code: event?.code ?? null,
            reason: typeof event?.reason === "string" ? event.reason : null,
            wasClean: event?.wasClean ?? null,
            ...summarizeSession(session),
        });
        if (downstream.readyState === WebSocket.OPEN) {
            downstream.close();
        }
    });

    upstream.on("error", (error) => {
        logDisplayDebug("display-proxy-upstream-error", {
            sessionId,
            upstreamUrl,
            error: error?.message || "Unknown upstream websocket error",
            ...summarizeSession(session),
        });
        if (downstream.readyState === WebSocket.OPEN) {
            downstream.close(1011, "Display upstream error");
        }
    });
});

httpServer.listen(PORT, () => {
    console.log(`Privileged docker runner listening on :${PORT}`);
});
