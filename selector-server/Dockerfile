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
CMD ["xvfb-run", "-a", "-s", "-screen 0 1280x900x24", "node", "run.js"]
