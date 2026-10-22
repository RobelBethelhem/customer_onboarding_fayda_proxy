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

# Oracle Instant Client for Thick mode, the mode the Windows server uses today (Thin mode cannot
# use Oracle native network encryption or old password verifiers). The zip holds symlinks:
# Info-ZIP unzip keeps them.
FROM alpine:3.20 AS oracle-client
ADD --checksum=sha256:e145921acc7959154c262ca0260d984f9fc964f354c553c585255c1a87e2811b \
    https://download.oracle.com/otn_software/linux/instantclient/2360000/instantclient-basic-linux.x64-23.6.0.24.10.zip /tmp/ic.zip
RUN apk add --no-cache unzip && unzip -q /tmp/ic.zip -d /tmp/ic \
 && mkdir -p /opt/oracle && mv /tmp/ic/instantclient_23_6 /opt/oracle/instantclient

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends libaio1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=oracle-client /opt/oracle/instantclient /opt/oracle/instantclient
RUN echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf && ldconfig
# ORACLE_CLIENT_PATH set to empty in the .env: Thin mode
ENV NODE_ENV=production \
    PORT=5000 \
    TZ=Africa/Addis_Ababa \
    FAYDA_KEYS_PATH=/app/keys \
    ORACLE_CLIENT_PATH=/opt/oracle/instantclient
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p uploads/face-videos keys && chown -R node:node /app
USER node
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
