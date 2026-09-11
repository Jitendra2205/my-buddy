# For hosts that take a container (Railway, Fly.io, Cloud Run) rather than a
# Node buildpack. Secrets come from the platform's env settings, never baked in.
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=3717
EXPOSE 3717

# data/ is written at runtime; mount a volume here to keep it across deploys.
VOLUME ["/app/data"]

CMD ["node", "server.js"]
