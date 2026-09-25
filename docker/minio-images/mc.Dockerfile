# MinIO client (mc), built from the official upstream source at one pinned release.
#
# Upstream withdrew its published images (quay.io tags now return "no such
# manifest", Docker Hub denies anonymous pulls), so GRIDGO builds its own from
# github.com/minio/mc and publishes ghcr.io/gridgoph/mc. Built and pushed by
# .github/workflows/minio-images.yml; see docs/STORAGE_API.md.
#
# Compose and CI run it with `--entrypoint /bin/sh -ec` and heredocs, so the
# runtime keeps a shell. mc holds no data, so it runs as a non-root user whose
# config lives in its own home.

ARG GO_IMAGE=golang:1.23.10-alpine3.22@sha256:9a425d78a8257fc92d41ad979d38cb54005bac3fdefbdadde868e004eccbb898
ARG RUNTIME_IMAGE=alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build

ARG MC_RELEASE_TAG=RELEASE.2025-07-21T05-28-08Z
ARG MC_COMMIT=ee72571936f15b0e65dc8b4a231a4dd445e5ccb6
ARG TARGETOS
ARG TARGETARCH

RUN apk add --no-cache git

WORKDIR /src
RUN git clone --depth 1 --branch "${MC_RELEASE_TAG}" https://github.com/minio/mc.git . \
 && actual="$(git rev-parse HEAD)" \
 && [ "${actual}" = "${MC_COMMIT}" ] \
 || { echo "tag ${MC_RELEASE_TAG} resolved to ${actual:-nothing}, expected ${MC_COMMIT}" >&2; exit 1; }

# go.mod pins `toolchain go1.23.10`; GOTOOLCHAIN=local refuses any silent download
# of a different compiler. The ldflags are upstream's own release stamping
# (buildscripts/gen-ldflags.go with MC_RELEASE=RELEASE), so `mc --version`
# reports the exact release and commit.
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
RUN go mod download
RUN version="$(echo "${MC_RELEASE_TAG#RELEASE.}" | sed -E 's/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/T\1:\2:\3Z/')" \
 && ldflags="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${version}")" \
 && GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build -tags kqueue -trimpath -ldflags "${ldflags}" -o /out/mc . \
 && install -D -m 0644 LICENSE /out/licenses/LICENSE \
 && install -D -m 0644 CREDITS /out/licenses/CREDITS

FROM ${RUNTIME_IMAGE}

ARG MC_RELEASE_TAG=RELEASE.2025-07-21T05-28-08Z
ARG MC_COMMIT=ee72571936f15b0e65dc8b4a231a4dd445e5ccb6

LABEL org.opencontainers.image.title="MinIO Client (mc)" \
      org.opencontainers.image.description="MinIO client built by GRIDGO from the official upstream source at ${MC_RELEASE_TAG}" \
      org.opencontainers.image.version="${MC_RELEASE_TAG}" \
      org.opencontainers.image.source="https://github.com/minio/mc" \
      org.opencontainers.image.revision="${MC_COMMIT}" \
      org.opencontainers.image.url="https://github.com/minio/mc/tree/${MC_RELEASE_TAG}" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.vendor="GRIDGO (rebuild of MinIO, Inc. source)" \
      ph.gridgo.build.definition="https://github.com/gridgoph/gridgo-api/blob/main/docker/minio-images/mc.Dockerfile"

RUN apk add --no-cache ca-certificates \
 && addgroup -g 10001 mc \
 && adduser -D -H -h /home/mc -u 10001 -G mc mc \
 && install -d -o mc -g mc -m 0700 /home/mc

COPY --from=build /out/mc /usr/bin/mc
COPY --from=build /out/licenses/ /licenses/

USER 10001:10001
ENV HOME=/home/mc
WORKDIR /home/mc

ENTRYPOINT ["mc"]
