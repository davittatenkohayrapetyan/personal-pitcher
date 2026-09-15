FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV production

# Alpine ships without a timezone database. Node still honours TZ because its
# Intl/ICU data is self-contained — so notification timestamps and log rotation
# are already local without this. The shell is what breaks: `date` inside the
# container reports UTC regardless of TZ, which silently misleads anyone
# debugging by four hours. ~2MB to make every clock in the image agree.
RUN apk add --no-cache tzdata
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/data ./data
# Writable directory for rotating JSON logs (LOG_DIR). Mount a volume here
# in production to persist logs across container restarts.
RUN mkdir -p /app/logs
ENV LOG_DIR=/app/logs
VOLUME ["/app/logs"]
EXPOSE 3000
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"
CMD ["node", "server.js"]
