# develop container
FROM node:24 AS develop

# build container
FROM node:24 AS build
USER node

COPY --chown=node:node . /app

WORKDIR /app

# TerriaJS's postinstall needs the Gulp installed by this project's devDependencies.
ENV PATH="/app/node_modules/.bin:${PATH}"

RUN yarn install --network-timeout 1000000
RUN yarn gulp release

# deploy container
FROM node:24-slim AS deploy

# terriajs-server registers no SIGTERM/SIGINT handlers, and node:24-slim has no init
# system, so without tini as PID 1, `docker stop` (and Kubernetes' pod termination,
# which works the same way) has nothing to catch the signal - the container just sits
# until the grace period expires and it gets SIGKILLed. tini forwards the signal to
# node and reaps zombies, so shutdown is immediate. Installed as root, before USER
# node, since apt-get needs root.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

USER node

WORKDIR /app

# Without the chown when copying directories, wwwroot is owned by root:root.
COPY --from=build --chown=node:node /app/wwwroot wwwroot
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build /app/serverconfig.json serverconfig.json
COPY --from=build /app/index.js index.js
COPY --from=build /app/package.json package.json
COPY --from=build /app/version.js version.js

EXPOSE 3001
ENV NODE_ENV=production
ENTRYPOINT [ "/usr/bin/tini", "--" ]
CMD [ "node", "./node_modules/terriajs-server/lib/app.js", "--config-file", "serverconfig.json" ]
