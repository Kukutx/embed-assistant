# syntax=docker/dockerfile:1
# embed-assistant server image: API + widget bundle + admin console in one process.

FROM node:26-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Node.js 25+ no longer bundles corepack: install the pnpm that package.json pins.
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")"
COPY packages/protocol/package.json packages/protocol/
COPY packages/widget/package.json packages/widget/
COPY apps/server/package.json apps/server/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm -r build \
 && pnpm --filter @embed-assistant/server deploy --prod --legacy /out \
 && cp -r packages/widget/dist /out/widget

FROM node:26-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/Kukutx/embed-assistant" \
      org.opencontainers.image.description="Embeddable, model-agnostic AI assistant" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 WIDGET_DIST_DIR=/app/widget
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
