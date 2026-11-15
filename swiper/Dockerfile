# Clip Tinder (swiper) for a server (Railway, Render, any Docker host).
# Config comes from environment variables (see .env.example); state lives in /data — mount a volume there.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3200 DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /data
EXPOSE 3200
CMD ["node", "src/server.js"]
