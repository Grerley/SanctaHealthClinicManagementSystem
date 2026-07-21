# Sancta clinic edge server — one image that serves the API + PWA against a
# PostgreSQL given by DATABASE_URL. Used for BOTH:
#   • Phase 0 (cloud-first): deploy to any Node host, point at a managed Postgres.
#   • Phase 1 (local edge):  run on a clinic computer against local Postgres.
# On boot it applies pending migrations (idempotent) then starts the server.
FROM node:22-slim

WORKDIR /app

# Install dependencies against the committed lockfile (reproducible), then build
# the PWA that the server serves as static assets.
COPY . .
RUN npm ci && npm run build -w @sancta/clinic-web

# The server serves the built PWA from WEB_DIST; cloud hosts inject PORT.
ENV WEB_DIST=/app/apps/clinic-web/dist \
    EDGE_PORT=8080 \
    NODE_ENV=production
EXPOSE 8080

# Apply migrations (safe to repeat), then serve. DATABASE_URL is provided at run
# time (never baked into the image). CLOUD_INGRESS_URL / SITE_ID are optional.
CMD ["sh", "-c", "node --experimental-strip-types scripts/migrate.ts && node --experimental-strip-types apps/clinic-edge/src/server.ts"]
