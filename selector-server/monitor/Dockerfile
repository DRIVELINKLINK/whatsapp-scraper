FROM node:22-alpine
ENV TZ=Asia/Jerusalem
RUN apk add --no-cache tzdata
WORKDIR /app
COPY monitor.mjs ./
CMD ["node", "monitor.mjs"]
