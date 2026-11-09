FROM node:26.12.1-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Railway passes matching service variables as build arguments.
# Next embeds public configuration in the browser bundle at build time.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SIGNA_ENABLED=false
ARG NEXT_PUBLIC_JBCENTER_URL
RUN npm run build

FROM node:26.12.1-alpine
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
