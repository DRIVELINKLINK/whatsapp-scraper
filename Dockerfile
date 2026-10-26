FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "src/index.js"]
