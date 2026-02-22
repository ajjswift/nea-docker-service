# docker-runner-service

Privileged execution API for running student code inside Docker, intended to be hosted on infrastructure that allows Docker access.

## Endpoints

- `GET /health`
- `POST /v1/sessions` creates a session and starts execution
- `GET /v1/sessions/:id/stream?streamToken=...` streams run events via WebSocket
- `POST /v1/sessions/:id/stdin` sends stdin
- `POST /v1/sessions/:id/stop` stops execution

Stream events mirror the websocket app contract:

- `programOutput`
- `programError`
- `programExit`

## Environment Variables

- `PORT` default `3030`
- `RUNNER_API_KEY` optional shared secret; if set, HTTP calls require `Authorization: Bearer <key>`
- `RUNNER_IMAGE` default `python:3.11-alpine`
- `RUNNER_MEMORY` default `256m`
- `RUNNER_CPUS` default `0.5`
- `RUNNER_TIMEOUT_MS` default `120000`
- `RUNNER_NETWORK` default `none`
- `MAX_BUFFERED_EVENTS` default `250`

## Run

```bash
npm install
npm start
```

Copy `/Users/alexx/projects/school/NEA/proper-thing/docker-runner-service/.env.example` to `.env` before running.
