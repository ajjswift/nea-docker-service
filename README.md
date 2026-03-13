# docker-runner-service

Privileged execution API for running student code inside Docker, intended to be hosted on infrastructure that allows Docker access.

## Endpoints

- `GET /health`
- `POST /v1/sessions` creates a session and starts execution
- `GET /v1/sessions/:id/stream?streamToken=...` streams run events via WebSocket
- `GET /v1/sessions/:id/files` returns the latest workspace snapshot for a session
- `POST /v1/sessions/:id/stdin` sends stdin
- `POST /v1/sessions/:id/stop` stops execution
- `POST /v1/python/format` formats Python via Ruff (`{ fileName, source }`)
- `POST /v1/python/lint` lints Python via Ruff (`{ fileName, source }`)

Stream events mirror the websocket app contract:

- `programOutput`
- `programError`
- `programExit`

## Environment Variables

- `PORT` default `3030`
- `RUNNER_API_KEY` optional shared secret; if set, HTTP calls require `Authorization: Bearer <key>`
- `RUNNER_IMAGE` default `python:3.11-alpine`
- `RUNNER_RUFF_IMAGE` default `ghcr.io/astral-sh/ruff:latest`
- `RUNNER_MEMORY` default `256m`
- `RUNNER_CPUS` default `0.5`
- `RUNNER_TIMEOUT_MS` default `120000`
- `RUNNER_TOOL_TIMEOUT_MS` default `20000` (timeout for formatter/linter calls)
- `RUNNER_NETWORK` default `none`
- `MAX_BUFFERED_EVENTS` default `250`
- `MAX_TOOL_INPUT_BYTES` default `250000`
- `RUNNER_SESSION_RETENTION_MS` default `30000` (keeps completed sessions briefly so late stream connections can still receive exit/output events)

## Run

```bash
npm install
npm start
```

Copy `/Users/alexx/projects/school/NEA/proper-thing/docker-runner-service/.env.example` to `.env` before running.
