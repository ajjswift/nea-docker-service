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
        -nopw >/tmp/x11vnc.log 2>&1 &
    X11VNC_PID=$!

    websockify \
        --web=/usr/share/novnc \
        "${NOVNC_PORT:-6080}" \
        "localhost:${VNC_PORT:-5900}" >/tmp/websockify.log 2>&1 &
    WEBSOCKIFY_PID=$!
fi

python -u "${ENTRY_FILE}"
