# Coperacha app for App Runner: Node 20, linux/amd64, production npm dependencies only.
# No secrets in the image: configuration arrives as environment variables at runtime.
FROM --platform=linux/amd64 node:20-slim

ENV NODE_ENV=production \
    PORT=3000 \
    APP_TIMEZONE=America/Mexico_City \
    TZ=America/Mexico_City \
    DATABASE_PATH=/app/data/coperacha.json

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/ src/
# The local store file is only a scratch copy here; the durable one is in S3.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
