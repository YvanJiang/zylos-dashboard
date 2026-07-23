FROM node:20-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    make \
    python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-bookworm-slim

ENV NODE_ENV=production
ENV HOME=/home/node
ENV ZYLOS_DIR=/home/node/zylos
ENV DASHBOARD_HOST=0.0.0.0
ENV DASHBOARD_PORT=3470

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .

RUN mkdir -p /home/node/zylos/components/dashboard \
  && chown -R node:node /home/node/zylos /app \
  && chmod +x docker/entrypoint.sh

USER node
EXPOSE 3470

ENTRYPOINT ["./docker/entrypoint.sh"]
CMD ["node", "src/index.js"]
