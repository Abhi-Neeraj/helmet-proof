# Runs the Helmet Proof server on any host that can run a container
# (Railway, Render, Fly.io, a VPS with Docker, and so on).
#
# The database and every video live in /data. Mount a persistent disk or
# volume there, or they are lost each time the container is replaced.

FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY tools ./tools

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    TRUST_PROXY=1

VOLUME /data
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
