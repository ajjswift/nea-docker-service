FROM python:3.11-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    fonts-dejavu-extra \
    fonts-noto-color-emoji \
    fonts-noto-core \
    fonts-symbola \
    libgl1 \
    libglib2.0-0 \
    libgomp1 \
    libsdl2-2.0-0 \
    libsdl2-image-2.0-0 \
    libsdl2-mixer-2.0-0 \
    libsdl2-ttf-2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    novnc \
    python3-tk \
    tk \
    websockify \
    x11-utils \
    x11vnc \
    xauth \
    xvfb \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt

RUN python -m pip install --no-cache-dir -r /tmp/requirements.txt

WORKDIR /workspace
