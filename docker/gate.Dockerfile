# A reproducible way to run the Electron gates without a desktop.
#
# The gates need real renderer processes and a display. This image supplies both: Xvfb for
# the display, and a working Chromium sandbox so that the result means something. Running
# Electron with --no-sandbox would make the gate pass trivially and prove nothing, because
# the gate is specifically about whether a buffer reaches a sandboxed renderer.
FROM node:22-bookworm-slim

# Electron's runtime dependencies, plus Xvfb. The list is long and every entry is load
# bearing: a missing one shows up as a renderer that exits without a message.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb \
      libgtk-3-0 \
      libnotify4 \
      libnss3 \
      libxss1 \
      libxtst6 \
      libatspi2.0-0 \
      libsecret-1-0 \
      libgbm1 \
      libasound2 \
      libdrm2 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libcups2 \
      libpango-1.0-0 \
      libcairo2 \
      xdg-utils \
      ca-certificates \
      dbus-x11 \
      xauth \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The manifests first, so the dependency layer is cached across source changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY packages/electron/package.json ./packages/electron/
COPY packages/react/package.json ./packages/react/
COPY packages/vue/package.json ./packages/vue/
COPY packages/svelte/package.json ./packages/svelte/

RUN npm ci

# Electron no longer unpacks its binary during npm install; it materialises on the first
# require. Resolving it here puts it on disk while this image is still root, which is the
# only point at which the sandbox helper below can be configured.
RUN node -e "import('electron').then((m) => console.log(m.default))"

# Chromium's setuid sandbox has to be owned by root and setuid to work. npm install cannot
# do this, so an Electron installed from npm always needs it done afterwards. Without it the
# renderer refuses to start and the only way forward looks like --no-sandbox, which would
# make the gate meaningless.
RUN test -e node_modules/electron/dist/chrome-sandbox \
  && chown root:root node_modules/electron/dist/chrome-sandbox \
  && chmod 4755 node_modules/electron/dist/chrome-sandbox

COPY . .

RUN npm run build

# Chromium will not run its sandbox as root, so the gates run as an ordinary user.
RUN useradd --create-home --shell /bin/bash gate \
  && chown -R gate:gate /app
USER gate

ENV ELECTRON_DISABLE_SECURITY_WARNINGS=1

# Xvfb wraps whatever is asked for. The default answers the question the project exists to
# answer.
ENTRYPOINT ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x1024x24"]
CMD ["node", "spikes/run-spike.mjs", "01"]
