FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive TZ=Asia/Jerusalem
WORKDIR /app/collector
COPY collector/package.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends xvfb xauth fonts-noto-core fonts-noto-color-emoji tzdata \
 && rm -rf /var/lib/apt/lists/*
COPY extension /app/extension
COPY collector/run.js ./
EXPOSE 8080
ENV DISPLAY=:99
CMD ["sh", "-c", "rm -f /tmp/.X99-lock; Xvfb :99 -screen 0 1280x900x24 -nolisten tcp >/dev/null 2>&1 & sleep 1; exec node run.js"]
