# Runs the gateway (dashboard, donation pages, overlays, API) in one container.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
# The SQLite database lives on a mounted volume so it survives restarts and redeploys.
ENV PORT=3000 DB_PATH=/data/gateway.db TRUST_PROXY=1
RUN mkdir -p /data
EXPOSE 3000
CMD ["npm", "start"]
