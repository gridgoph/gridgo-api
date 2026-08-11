# syntax=docker/dockerfile:1
#
# GRIDGO API — production image.
#
# Two stages, so the shipped layer carries no build toolchain and no dev tree:
#   deps    — `npm ci --omit=dev`, which for this project is exactly one runtime
#             dependency (`minio`); everything else is `node:` builtins.
#   runner  — that tree plus `src/`, running as a non-root user.
#
# There is no compile step. This is plain ESM run by node, so the image is the
# source plus its lockfile-pinned dependency — nothing is transformed, and the
# thing that runs in production is the thing in the repository.
#
# See docs/DEPLOYMENT.md.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev


FROM node:22-alpine AS runner
WORKDIR /app

ARG GRIDGO_BUILD_SHA=unknown
ARG GRIDGO_BUILD_TIME=unknown

# NODE_ENV=production is baked in, not left to the compose file: it is what
# switches on the refusal to start without environment-owned account passwords,
# an exact CORS allowlist, and a private object-storage endpoint. A production
# image that could be started in development mode by omitting one variable would
# defeat that check exactly when it matters.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    STORE_PATH=/var/lib/gridgo-api/store.json \
    GRIDGO_BUILD_SHA=${GRIDGO_BUILD_SHA} \
    GRIDGO_BUILD_TIME=${GRIDGO_BUILD_TIME}

# Own uid/gid rather than the image's built-in `node` user, so the numbers are
# stable and obvious in `docker top` — and so the store volume's ownership is
# predictable across image rebuilds.
RUN addgroup --system --gid 1001 gridgo \
 && adduser --system --uid 1001 --ingroup gridgo gridgo

COPY --from=deps --chown=gridgo:gridgo /app/node_modules ./node_modules
COPY --chown=gridgo:gridgo package.json package-lock.json ./
COPY --chown=gridgo:gridgo src ./src

# The whole domain database is one JSON file, and it holds password hashes,
# session tokens and operational records. It lives *only* here, on a volume the
# compose file mounts, so replacing the container never touches it. Docker seeds
# a fresh named volume from this directory, which is how the volume inherits
# gridgo:gridgo ownership and 0700 without any host-side chown.
#
# Deliberately no `VOLUME` instruction: that would make a bare `docker run`
# silently create a throwaway anonymous volume, which is precisely the mistake
# — data that looks persisted and is not — this image exists to prevent.
RUN install -d -o gridgo -g gridgo -m 0700 /var/lib/gridgo-api

# `POST /files` never buffers an upload in RAM: it spools the bytes to
# `$PWD/.tmp/uploads` and streams that file to MinIO. WORKDIR is created by the
# builder as root, so without this the spool directory cannot be created and
# *every* upload fails with a 500 — while `/health` stays green and the JSON
# routes all work, which is how it hides. Deliberately a subdirectory: the
# application code above it stays root-owned and unwritable by the API user.
RUN install -d -o gridgo -g gridgo -m 0700 /app/.tmp /app/.tmp/uploads

USER gridgo
EXPOSE 8787

# The proxy reaches this container by name on the `gridgo-edge` network; this
# check is the container's own opinion of itself, used by compose and visible in
# `docker ps`. `/health` needs no credentials and sends no Origin, so it is not
# affected by the CORS allowlist.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Plain HTTP on purpose. Cloudflare terminates TLS in front of the server in
# Flexible mode, so an in-container HTTPS redirect would loop forever.
CMD ["node", "src/server.js"]
