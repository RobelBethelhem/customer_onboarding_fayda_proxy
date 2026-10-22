# Fayda backend (Express, port 5000): Fayda OTP / eKYC, face checks, FlexCube Oracle queries, and the
# relay to the dashboard. Debian (glibc) image: onnxruntime-node, canvas and sharp ship glibc builds.
#
# Never baked into the image — mounted / set when the container runs:
#   /app/keys     Fayda partner .p12 files (read-only)     FAYDA_KEYS_PATH=/app/keys
#   /app/uploads  face videos for KYC (persistent)
#   secrets       .env (FLEXCUBE_DB_*, JWT_SECRET, FACE_RESULT_SECRET, FAYDA_* …)

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* .npmrc ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=5000 \
    TZ=Africa/Addis_Ababa \
    FAYDA_KEYS_PATH=/app/keys
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p uploads/face-videos keys && chown -R node:node /app
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
