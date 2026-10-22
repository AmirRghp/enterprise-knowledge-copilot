FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dependencies
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web/ ./
COPY licenses/ ./licenses/
RUN npm run build
RUN mkdir -p /app/THIRD-PARTY-LICENSES && \
    find node_modules -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -iname 'COPYING*' \) \
      -exec sh -c 'for file do dest="/app/THIRD-PARTY-LICENSES/$file"; mkdir -p "$(dirname "$dest")"; cp "$file" "$dest"; done' sh {} +

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/THIRD-PARTY-LICENSES ./THIRD-PARTY-LICENSES
COPY --from=builder --chown=node:node /app/licenses ./licenses
USER node
EXPOSE 3000
CMD ["node", "server.js"]
