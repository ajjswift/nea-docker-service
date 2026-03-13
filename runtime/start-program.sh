#!/bin/sh
set -eu

cleanup() {
    if [ -n "${WEBSOCKIFY_PID:-}" ]; then
        kill "${WEBSOCKIFY_PID}" 2>/dev/null || true
    fi
    if [ -n "${X11VNC_PID:-}" ]; then
        kill "${X11VNC_PID}" 2>/dev/null || true
    fi
    if [ -n "${XVFB_PID:-}" ]; then
        kill "${XVFB_PID}" 2>/dev/null || true
    fi
}

trap cleanup EXIT

wait_for_tcp_port() {
    PORT_TO_CHECK="$1"
    python - "$PORT_TO_CHECK" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.settimeout(0.2)
try:
    sock.connect(("127.0.0.1", port))
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
}

wait_for_service() {
    SERVICE_NAME="$1"
    SERVICE_PID="$2"
    SERVICE_PORT="$3"
    SERVICE_LOG="$4"

    for _ in $(seq 1 150); do
        if ! kill -0 "${SERVICE_PID}" 2>/dev/null; then
            echo "${SERVICE_NAME} failed to start." >&2
            if [ -f "${SERVICE_LOG}" ]; then
                cat "${SERVICE_LOG}" >&2
            fi
            exit 1
        fi

        if wait_for_tcp_port "${SERVICE_PORT}"; then
            return
        fi

        sleep 0.1
    done

    echo "${SERVICE_NAME} did not become ready in time." >&2
    if [ -f "${SERVICE_LOG}" ]; then
        cat "${SERVICE_LOG}" >&2
    fi
    exit 1
}

if [ "${ENABLE_DISPLAY:-0}" = "1" ]; then
    export DISPLAY=":${DISPLAY_NUMBER:-99}"
    export SDL_VIDEODRIVER="x11"
    export SDL_AUDIODRIVER="${SDL_AUDIODRIVER:-dummy}"

    Xvfb "${DISPLAY}" -screen 0 "${DISPLAY_SCREEN:-1280x720x24}" -ac >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!

    SOCKET_PATH="/tmp/.X11-unix/X${DISPLAY_NUMBER:-99}"
    for _ in $(seq 1 150); do
        if [ -S "${SOCKET_PATH}" ]; then
            break
        fi
        sleep 0.1
    done

    if [ ! -S "${SOCKET_PATH}" ]; then
        echo "Virtual display failed to start." >&2
        exit 1
    fi

    x11vnc \
        -display "${DISPLAY}" \
        -rfbport "${VNC_PORT:-5900}" \
        -localhost \
        -forever \
        -shared \
        -noxdamage \
        -wait 5 \
        -defer 5 \
        -repeat \
        -nopw >/tmp/x11vnc.log 2>&1 &
    X11VNC_PID=$!

    websockify \
        --web=/usr/share/novnc \
        "${NOVNC_PORT:-6080}" \
        "localhost:${VNC_PORT:-5900}" >/tmp/websockify.log 2>&1 &
    WEBSOCKIFY_PID=$!

    wait_for_service "x11vnc" "${X11VNC_PID}" "${VNC_PORT:-5900}" "/tmp/x11vnc.log"
    wait_for_service "websockify" "${WEBSOCKIFY_PID}" "${NOVNC_PORT:-6080}" "/tmp/websockify.log"
fi

python -u "${ENTRY_FILE}"
