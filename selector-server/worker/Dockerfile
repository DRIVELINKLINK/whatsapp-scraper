FROM node:22-bookworm-slim
ENV TZ=Asia/Jerusalem
RUN apt-get update && apt-get install -y --no-install-recommends tzdata ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY worker.ts ./
COPY lib ./lib
CMD ["npx", "tsx", "worker.ts"]
