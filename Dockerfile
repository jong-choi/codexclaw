# syntax=docker/dockerfile:1

FROM node:22-bookworm

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY bin ./bin
COPY src ./src
COPY README.md ./README.md

RUN mkdir -p /home/node/.codexclaw && chown -R node:node /app /home/node/.codexclaw

USER node

ENTRYPOINT ["node", "./bin/codexclaw.mjs"]
CMD ["help"]
