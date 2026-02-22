import crypto from "crypto";
import { writeFile, mkdtemp, rm } from "fs/promises";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { basename, join } from "path";

const PORT = Number(process.env.PORT || 3030);
const RUNNER_API_KEY = `${process.env.RUNNER_API_KEY || ""}`.trim();
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || "python:3.11-alpine";
const RUNNER_MEMORY = process.env.RUNNER_MEMORY || "256m";
const RUNNER_CPUS = process.env.RUNNER_CPUS || "0.5";
const RUNNER_TIMEOUT_MS = Number(process.env.RUNNER_TIMEOUT_MS || 120000);
const RUNNER_NETWORK = process.env.RUNNER_NETWORK || "none";
const MAX_BUFFERED_EVENTS = Number(process.env.MAX_BUFFERED_EVENTS || 250);

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function getBearerToken(request) {
    const value = request.headers.get("authorization");
    if (!value) return "";
    const [scheme, token] = value.split(" ");
    if (scheme?.toLowerCase() !== "bearer") return "";
    return `${token || ""}`.trim();
}

function isAuthorized(request) {
    if (!RUNNER_API_KEY) return true;
    return getBearerToken(request) === RUNNER_API_KEY;
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
            if (ws.readyState === 1) {
                ws.send(payload);
            }
        }
    }

    attachSubscriber(ws) {
        this.subscribers.add(ws);

        if (this.bufferedEvents.length > 0) {
            for (const payload of this.bufferedEvents) {
                if (ws.readyState !== 1) break;
                ws.send(payload);
            }
            this.bufferedEvents = [];
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
    }

    get(id) {
        return this.sessions.get(id) || null;
    }

    async create(files, entryFile) {
        const session = new ExecutionSession(files, entryFile, (id) => {
            this.sessions.delete(id);
        });

        this.sessions.set(session.id, session);
        try {
            await session.start();
            return session;
        } catch (error) {
            this.sessions.delete(session.id);
            await session.cleanup();
            throw error;
        }
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

const server = Bun.serve({
    port: PORT,
    async fetch(request, serverRef) {
        const url = new URL(request.url);

        if (request.method === "GET" && url.pathname === "/health") {
            return jsonResponse({ ok: true });
        }

        if (request.method === "POST" && url.pathname === "/v1/sessions") {
            if (!isAuthorized(request)) {
                return jsonResponse({ error: "Unauthorized." }, 401);
            }

            let body;
            try {
                body = await request.json();
            } catch {
                return jsonResponse({ error: "Invalid JSON body." }, 400);
            }

            try {
                const session = await sessions.create(body?.files, body?.entryFile);
                return jsonResponse({
                    sessionId: session.id,
                    streamToken: session.streamToken,
                });
            } catch (error) {
                console.error("Failed to create session:", error);
                return jsonResponse(
                    {
                        error:
                            error?.message || "Failed to create execution session.",
                    },
                    500
                );
            }
        }

        const route = parseSessionRoute(url.pathname);
        if (!route) {
            return jsonResponse({ error: "Not found." }, 404);
        }

        const session = sessions.get(route.sessionId);
        if (!session) {
            return jsonResponse({ error: "Session not found." }, 404);
        }

        if (route.action === "stream" && request.method === "GET") {
            const streamToken = `${url.searchParams.get("streamToken") || ""}`;
            if (!streamToken || streamToken !== session.streamToken) {
                return jsonResponse({ error: "Unauthorized stream access." }, 401);
            }

            if (
                serverRef.upgrade(request, {
                    data: { sessionId: route.sessionId },
                })
            ) {
                return;
            }
            return jsonResponse({ error: "WebSocket upgrade failed." }, 500);
        }

        if (!isAuthorized(request)) {
            return jsonResponse({ error: "Unauthorized." }, 401);
        }

        if (route.action === "stdin" && request.method === "POST") {
            let body;
            try {
                body = await request.json();
            } catch {
                return jsonResponse({ error: "Invalid JSON body." }, 400);
            }

            try {
                await session.sendInput(body?.input ?? "");
                return jsonResponse({ ok: true });
            } catch (error) {
                return jsonResponse(
                    { error: error?.message || "Failed to send input." },
                    400
                );
            }
        }

        if (route.action === "stop" && request.method === "POST") {
            try {
                await session.stop();
                return jsonResponse({ ok: true });
            } catch (error) {
                return jsonResponse(
                    { error: error?.message || "Failed to stop session." },
                    500
                );
            }
        }

        return jsonResponse({ error: "Not found." }, 404);
    },
    websocket: {
        open(ws) {
            const session = sessions.get(ws.data.sessionId);
            if (!session) {
                ws.close();
                return;
            }
            session.attachSubscriber(ws);
        },
        close(ws) {
            const session = sessions.get(ws.data.sessionId);
            if (!session) return;
            session.detachSubscriber(ws);
        },
    },
});

console.log(`Privileged docker runner listening on :${server.port}`);
