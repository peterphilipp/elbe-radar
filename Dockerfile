FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY . .

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
