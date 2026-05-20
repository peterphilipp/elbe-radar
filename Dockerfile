FROM node:20-alpine
WORKDIR /app

ARG BUILD_SHA=dev
ARG BUILD_TIME=unknown
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_TIME=${BUILD_TIME}

# System-CA-Bundle aktuell halten und Node anweisen es zu nutzen
# (Node nutzt sonst sein eingebautes – das kann veraltet sein)
RUN apk add --no-cache python3 make g++ ca-certificates tini \
 && update-ca-certificates
ENV NODE_OPTIONS="--use-openssl-ca"

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Healthcheck: liefert exitcode 1 wenn AIS länger als 5 Min keine Nachricht
HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD wget -q -O - http://localhost:3000/api/health || exit 1

EXPOSE 3000
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node", "server/index.js"]
