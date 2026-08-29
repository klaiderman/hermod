# Built on the official Playwright image (Chromium + its system deps). Runs
# Patchright's Chromium as a non-root user, uses tini to reap child processes and
# forward SIGTERM, and runs headful under Xvfb by default (headless gets
# challenged on signed-out ChatGPT).
#
# OpenShift-ready: the runtime stage assumes it may be started as an arbitrary
# non-root UID in the root group (GID 0), so writable paths are group-0 writable
# and HOME points at /tmp. --no-sandbox and --disable-dev-shm-usage in the launch
# args cover the pod's dropped capabilities and small /dev/shm.
#
# Keep the base image's Chromium and the patchright version in step; bump together.
ARG PLAYWRIGHT_VERSION=v1.52.0-jammy

FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS builder
WORKDIR /app

# The runtime stage installs the browser, so skip the postinstall here to keep the layer small.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION} AS runtime
WORKDIR /app

# tini as PID 1 for signal handling and zombie reaping (the browser spawns children).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

# Headful under Xvfb is the working stealthy setup; headless is detectable.
# HOME=/tmp so an arbitrary injected UID can write the Xvfb auth file and caches;
# PLAYWRIGHT_BROWSERS_PATH pins the browser to a fixed, baked-in location.
ENV NODE_ENV=production \
    PORT=3000 \
    HEADLESS=false \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Install Patchright's Chromium into the fixed browser path, then make the app and
# browser trees group-0 readable and writable so any non-root UID OpenShift injects
# (added to GID 0) can execute the browser and write what it needs.
RUN npx patchright install chromium \
    && chgrp -R 0 /app /ms-playwright \
    && chmod -R g=u /app /ms-playwright

USER 1001:0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
# Headful on a virtual display so there's no window but the browser still looks real.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1280x1024x24", "node", "dist/main.js"]
# To run genuinely headless instead (more detectable), set HEADLESS=true and use:
# CMD ["node", "dist/main.js"]
