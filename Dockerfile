# The racecars game server (app/server), for Fly.io (fly.toml) or any container host. Build context: the repo root
# (.dockerignore lets in only what the server needs: app/server, app/src, app/package*.json and each car's
# model.json + meta.json - no GLBs, textures or Tripo files). See app/server/DEPLOY.md.
FROM node:25-slim

# node 25: built-in node:sqlite and TypeScript type stripping - the server runs its .ts as is, like `npm run server`
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data

# the repo's layout under /srv (the server finds the cars at ../asset-generation from app/, and the sim build id hashes
# the same paths the site's build does)
WORKDIR /srv/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY asset-generation/assets/cars /srv/asset-generation/assets/cars
COPY app/src ./src
COPY app/server ./server
RUN install -m 0755 server/docker-entrypoint.sh /usr/local/bin/racecars-entrypoint \
  && mkdir -p /data && chown node:node /data

EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# starts as root only to hand the volume (mounted root-owned) to the node user, then runs the server as node (uid 1000)
ENTRYPOINT ["racecars-entrypoint"]
CMD ["node", "server/index.ts"]
