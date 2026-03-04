import crypto from "crypto";
import { createServer } from "http";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { basename, join } from "path";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 3030);
const RUNNER_API_KEY = `${process.env.RUNNER_API_KEY || ""}`.trim();
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "python:3.11-alpine";
const RUNNER_RUFF_IMAGE =
    process.env.RUNNER_RUFF_IMAGE || "ghcr.io/astral-sh/ruff:latest";
const RUNNER_MEMORY = process.env.RUNNER_MEMORY || "1024m";
const RUNNER_CPUS = process.env.RUNNER_CPUS || "1";
const RUNNER_TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS || 1200000);
const RUNNER_TOOL_TIMEOUT_MS = Number(
    process.env.RUNNER_TOOL_TIMEOUT_MS || 200000,
);
const RUNNER_NETWORK = process.env.RUNNER_NETWORK || "none";
const MAX_BUFFERED_EVENTS = Number(process.env.MAX_BUFFERED_EVENTS || 250);
const MAX_TOOL_INPUT_BYTES = Number(
    process.env.MAX_TOOL_INPUT_BYTES || 250000
);
const RUNNER_SESSION_RETENTION_MS = Number(
    process.env.RUNNER_SESSION_RETENTION_MS || 30000
);

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
    constructor(files, entryFile, onDispose) {
        this.id = crypto.randomUUID();
        this.streamToken = crypto.randomUUID();
        this.files = normalizeFiles(files);
        this.entryFile = resolveEntryFile(this.files, entryFile);
        this.onDispose = onDispose;

        this.tempDir = null;
        this.containerName = `python-run-${crypto.randomUUID()}`;
        this.process = null;
        this.timeoutId = null;
        this.cleaned = false;
        this.stopping = false;
        this.ended = false;

        this.subscribers = new Set();
        this.bufferedEvents = [];
    }

    async start() {
        this.tempDir = await mkdtemp(join(tmpdir(), "runner-"));
        for (const file of this.files) {
            await writeFile(join(this.tempDir, file.name), file.content, "utf-8");
        }

        const dockerArgs = [
            "run",
            "--rm",
            "-i",
            "--name",
            this.containerName,
            "--network",
            RUNNER_NETWORK,
            "--memory",
            RUNNER_MEMORY,
            "--cpus",
            RUNNER_CPUS,
            "-v",
            `${this.tempDir}:/workspace`,
            "-w",
            "/workspace",
            RUNNER_IMAGE,
            "python",
            "-u",
            this.entryFile,
        ];

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
            this.emit({
                type: "programError",
                data: error?.message || "Docker process error.",
            });
        });

        this.process.on("close", async (exitCode) => {
            this.emit({ type: "programExit", data: { exitCode } });
            await this.cleanup();
        });
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

    async stop() {
        if (this.stopping) return;
        this.stopping = true;

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

        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }

        this.process = null;
        this.containerName = null;

        if (this.tempDir) {
            try {
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
        return this.sessions.get(id) || null;
    }

    async create(files, entryFile) {
        const session = new ExecutionSession(files, entryFile, (id) => {
            this.markForCleanup(id);
        });

        this.sessions.set(session.id, session);
        try {
            await session.start();
            return session;
        } catch (error) {
            this.deleteNow(session.id);
            await session.cleanup();
            throw error;
        }
    }

    markForCleanup(id) {
        if (!this.sessions.has(id)) return;
        if (this.cleanupTimers.has(id)) return;

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
                const session = await sessions.create(body?.files, body?.entryFile);
                sendJson(res, 200, {
                    sessionId: session.id,
                    streamToken: session.streamToken,
                });
            } catch (error) {
                console.error("Failed to create session:", error);
                sendJson(res, 500, {
                    error: error?.message || "Failed to create execution session.",
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

httpServer.on("upgrade", (req, socket, head) => {
    try {
        const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
        const route = parseSessionRoute(url.pathname);

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

httpServer.listen(PORT, () => {
    console.log(`Privileged docker runner listening on :${PORT}`);
});
