# MinIO server, built from the official upstream source at one pinned release.
#
# Upstream withdrew its published images (quay.io tags now return "no such
# manifest", Docker Hub denies anonymous pulls), so GRIDGO builds its own from
# github.com/minio/minio and publishes ghcr.io/gridgoph/minio. Built and pushed
# by .github/workflows/minio-images.yml; see docs/STORAGE_API.md.
#
# The runtime mirrors the upstream image where compose depends on it: the
# upstream entrypoint (so `command: server /data` works), `curl` for the
# healthcheck, /data as the volume, and root as the default user. Root is kept on
# purpose: every existing gridgo_minio_data volume was written by the upstream
# root-run image, and a non-root server cannot write to it.

ARG GO_IMAGE=golang:1.24.2-alpine3.21@sha256:7772cb5322baa875edd74705556d08f0eeca7b9c4b5367754ce3f2f00041ccee
ARG RUNTIME_IMAGE=alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS build

ARG MINIO_RELEASE_TAG=RELEASE.2025-07-23T15-54-02Z
ARG MINIO_COMMIT=7ced9663e6a791fef9dc6be798ff24cda9c730ac
ARG TARGETOS
ARG TARGETARCH

RUN apk add --no-cache git

WORKDIR /src
RUN git clone --depth 1 --branch "${MINIO_RELEASE_TAG}" https://github.com/minio/minio.git . \
 && actual="$(git rev-parse HEAD)" \
 && [ "${actual}" = "${MINIO_COMMIT}" ] \
 || { echo "tag ${MINIO_RELEASE_TAG} resolved to ${actual:-nothing}, expected ${MINIO_COMMIT}" >&2; exit 1; }

# go.mod pins `toolchain go1.24.2`; GOTOOLCHAIN=local refuses any silent download
# of a different compiler. The ldflags are upstream's own release stamping
# (buildscripts/gen-ldflags.go with MINIO_RELEASE=RELEASE), so `minio --version`
# reports the exact release and commit.
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
RUN go mod download
RUN version="$(echo "${MINIO_RELEASE_TAG#RELEASE.}" | sed -E 's/T([0-9]{2})-([0-9]{2})-([0-9]{2})Z$/T\1:\2:\3Z/')" \
 && ldflags="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go "${version}")" \
 && GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build -tags kqueue -trimpath -ldflags "${ldflags}" -o /out/minio . \
 && install -D -m 0755 dockerscripts/docker-entrypoint.sh /out/docker-entrypoint.sh \
 && install -D -m 0644 LICENSE /out/licenses/LICENSE \
 && install -D -m 0644 CREDITS /out/licenses/CREDITS

FROM ${RUNTIME_IMAGE}

ARG MINIO_RELEASE_TAG=RELEASE.2025-07-23T15-54-02Z
ARG MINIO_COMMIT=7ced9663e6a791fef9dc6be798ff24cda9c730ac

LABEL org.opencontainers.image.title="MinIO" \
      org.opencontainers.image.description="MinIO server built by GRIDGO from the official upstream source at ${MINIO_RELEASE_TAG}" \
      org.opencontainers.image.version="${MINIO_RELEASE_TAG}" \
      org.opencontainers.image.source="https://github.com/minio/minio" \
      org.opencontainers.image.revision="${MINIO_COMMIT}" \
      org.opencontainers.image.url="https://github.com/minio/minio/tree/${MINIO_RELEASE_TAG}" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.vendor="GRIDGO (rebuild of MinIO, Inc. source)" \
      ph.gridgo.build.definition="https://github.com/gridgoph/gridgo-api/blob/main/docker/minio-images/minio.Dockerfile"

RUN apk add --no-cache ca-certificates curl

# The same defaults the upstream image sets.
ENV MINIO_ACCESS_KEY_FILE=access_key \
    MINIO_SECRET_KEY_FILE=secret_key \
    MINIO_ROOT_USER_FILE=access_key \
    MINIO_ROOT_PASSWORD_FILE=secret_key \
    MINIO_KMS_SECRET_KEY_FILE=kms_master_key \
    MINIO_CONFIG_ENV_FILE=config.env \
    MC_CONFIG_DIR=/tmp/.mc

COPY --from=build /out/minio /out/docker-entrypoint.sh /usr/bin/
COPY --from=build /out/licenses/ /licenses/

EXPOSE 9000
VOLUME ["/data"]

ENTRYPOINT ["/usr/bin/docker-entrypoint.sh"]
CMD ["minio"]
