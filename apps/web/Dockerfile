FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS dependencies
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/web/ ./
RUN npm run build
RUN find .next/standalone/node_modules/@img -mindepth 1 -maxdepth 1 -type d -name 'sharp-*' -exec rm -r {} + && \
    rm -r .next/standalone/node_modules/sharp && \
    test -z "$(find .next/standalone/node_modules -type f \( -iname '*sharp*' -o -iname '*libvips*' \) -print -quit)"
RUN mkdir -p /app/THIRD-PARTY-LICENSES && \
    find node_modules -type f \( -iname 'LICENSE*' -o -iname 'NOTICE*' -o -iname 'COPYING*' \) \
      -exec sh -c 'for file do dest="/app/THIRD-PARTY-LICENSES/$file"; mkdir -p "$(dirname "$dest")"; cp "$file" "$dest"; done' sh {} +

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/THIRD-PARTY-LICENSES ./THIRD-PARTY-LICENSES
COPY --chown=node:node LICENSE NOTICE ./
COPY --chown=node:node apps/web/src/fonts/OFL.txt ./licenses/OFL.txt
USER node
EXPOSE 3000
CMD ["node", "server.js"]
